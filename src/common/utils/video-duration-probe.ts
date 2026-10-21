/**
 * MP4 视频时长探测：仅凭 URL 对产物做纯 Node 元数据解析，不依赖 ffmpeg。
 * 用途：AI Gateway 视频终态回调未回传正数 duration_seconds（自动时长档 / 网关缺失 /
 * 回传 0）时，对产物视频做一次兜底探测回写真实时长；拿不到返回 null，调用方回落本地快照。
 * 原理：范围请求取文件头走查顶层 box；moov 不在头部（常见为大 mdat 挡路、moov 收尾）时
 * 按 box 头逐个追偏移定位 moov，再取 moov.mvhd 的 timescale + duration 换算秒。
 * 任何失败（非 MP4 / 网络错误 / 字段异常 / 超出抓取上限）一律返回 null，绝不抛错。
 */

const PROBE_TIMEOUT_MS = 5_000
const HEAD_BYTES = 64 * 1024
const MAX_MOOV_BYTES = 8 * 1024 * 1024
/** 逐头追偏移定位 moov 时最多越过的非 moov 顶层 box 数（ftyp + mdat + free…量级） */
const MAX_BOX_HOPS = 8
/** 合理秒数上限（1 小时）：防止解析到脏数据写出离谱时长 */
const MAX_DURATION_SEC = 3_600

interface Mp4Box {
  type: string
  /** box 头（含 size 字段）在文件中的绝对偏移 */
  start: number
  /** box 总字节数（含头）；64 位 largesize 时为 Number 化的值 */
  size: number
  /** box 头长度（size 字段为 1 时 16 字节，否则 8 字节） */
  headerLen: number
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, false)
}

/** 解析 base+offset 处的 box 头；字节不足 / size 非法 / size=0（延伸到文件尾）返回 null */
function readBox(view: DataView, base: number, offset: number): Mp4Box | null {
  if (offset + 8 > view.byteLength) return null
  const size32 = readU32(view, offset)
  let size = size32
  let headerLen = 8
  if (size32 === 1) {
    if (offset + 16 > view.byteLength) return null
    size = readU32(view, offset + 8) * 2 ** 32 + readU32(view, offset + 12)
    headerLen = 16
  } else if (size32 === 0) {
    // size=0 表示 box 延伸到文件尾（通常是最后的 mdat）：其后不再有可寻址 box
    return null
  }
  if (size < headerLen) return null
  const type = String.fromCharCode(
    view.getUint8(offset + 4),
    view.getUint8(offset + 5),
    view.getUint8(offset + 6),
    view.getUint8(offset + 7)
  )
  return { type, start: base + offset, size, headerLen }
}

/** 从 moov box 载荷中找 mvhd（moov 首个子 box）并换算秒；找不到或字段异常返回 null */
function durationSecFromMoov(moov: Uint8Array): number | null {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength)
  let offset = 0
  while (offset + 8 <= moov.byteLength) {
    const box = readBox(view, 0, offset)
    if (!box) break
    if (box.type === "mvhd") {
      const version = view.getUint8(offset + 8)
      if (version === 1) {
        // version 1：creation/modification 8 字节，timescale @28（u32），duration @32（u64）
        if (offset + 40 > moov.byteLength) return null
        const timescale = readU32(view, offset + 28)
        const duration = readU32(view, offset + 32) * 2 ** 32 + readU32(view, offset + 36)
        return normalizeDurationSec(timescale, duration)
      }
      // version 0：timescale @20（u32），duration @24（u32）
      if (offset + 28 > moov.byteLength) return null
      const timescale = readU32(view, offset + 20)
      const duration = readU32(view, offset + 24)
      return normalizeDurationSec(timescale, duration)
    }
    offset += box.size
  }
  return null
}

function normalizeDurationSec(timescale: number, duration: number): number | null {
  if (!Number.isFinite(timescale) || timescale <= 0) return null
  if (!Number.isFinite(duration) || duration <= 0) return null
  const seconds = Math.round(duration / timescale)
  if (seconds <= 0 || seconds > MAX_DURATION_SEC) return null
  return seconds
}

/** 读响应体至多 maxBytes 后取消流（范围请求被降级为全量 200 响应时避免整段视频进内存） */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.byteLength
      if (received >= maxBytes) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const out = new Uint8Array(Math.min(received, maxBytes))
  let filled = 0
  for (const chunk of chunks) {
    if (filled >= out.byteLength) break
    const take = Math.min(chunk.byteLength, out.byteLength - filled)
    out.set(chunk.subarray(0, take), filled)
    filled += take
  }
  return out
}

async function fetchRange(
  url: string,
  start: number,
  end: number,
  fetchImpl: typeof fetch
): Promise<Uint8Array | null> {
  const response = await fetchImpl(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  if (!response.ok) return null
  return readCapped(response, end - start + 1)
}

/** 拉取已定位的 moov box 载荷并解析时长 */
async function fetchMoovDuration(
  url: string,
  moov: Mp4Box,
  fetchImpl: typeof fetch
): Promise<number | null> {
  const bodyLen = moov.size - moov.headerLen
  if (bodyLen <= 0 || bodyLen > MAX_MOOV_BYTES) return null
  const body = await fetchRange(
    url,
    moov.start + moov.headerLen,
    moov.start + moov.size - 1,
    fetchImpl
  )
  if (!body) return null
  return durationSecFromMoov(body)
}

/**
 * 探测 MP4 时长（秒，四舍五入取整）。非 MP4 / 探测失败返回 null。
 * @param fetchImpl 仅供单测注入；生产用全局 fetch
 */
export async function probeMp4DurationSec(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<number | null> {
  try {
    const head = await fetchRange(url, 0, HEAD_BYTES - 1, fetchImpl)
    if (!head || head.byteLength < 8) return null
    const headView = new DataView(head.buffer, head.byteOffset, head.byteLength)
    let cursor = 0
    for (;;) {
      const box = readBox(headView, 0, cursor)
      if (!box) break
      if (box.type === "moov") {
        // moov 完整落在头部抓取范围内则免第二次请求
        if (cursor + box.size <= head.byteLength) {
          return durationSecFromMoov(head.subarray(cursor + box.headerLen, cursor + box.size))
        }
        return await fetchMoovDuration(url, box, fetchImpl)
      }
      cursor += box.size
    }
    // 头部窗口耗尽（大 mdat 挡路 / moov 收尾）：从游标处逐个追 box 头定位 moov
    for (let hop = 0; hop < MAX_BOX_HOPS; hop++) {
      const header = await fetchRange(url, cursor, cursor + 15, fetchImpl)
      if (!header || header.byteLength < 8) return null
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
      const box = readBox(view, cursor, 0)
      if (!box) return null
      if (box.type === "moov") return await fetchMoovDuration(url, box, fetchImpl)
      cursor += box.size
    }
    return null
  } catch {
    return null
  }
}
