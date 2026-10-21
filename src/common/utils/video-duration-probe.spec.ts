import { probeMp4DurationSec } from "./video-duration-probe"

/** 构造一个 MP4 box：8 字节头（size + type）+ payload */
function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, out.byteLength, false)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(payload, 8)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, false)
  return out
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false)
  return out
}

/** mvhd version 0：timescale / duration 各占 4 字节，其余字段以填充代替 */
function mvhdV0(timescale: number, duration: number): Uint8Array {
  return box(
    "mvhd",
    concat(new Uint8Array(4), u32(0), u32(0), u32(timescale), u32(duration), new Uint8Array(80))
  )
}

/** mvhd version 1：creation/modification 8 字节，duration 8 字节 */
function mvhdV1(timescale: number, duration: number): Uint8Array {
  return box(
    "mvhd",
    concat(
      new Uint8Array([1, 0, 0]), // version(1) + flags(3)
      u64(0),
      u64(0),
      u32(timescale),
      u64(duration),
      new Uint8Array(80)
    )
  )
}

function moov(children: Uint8Array[]): Uint8Array {
  return box("moov", concat(...children))
}

const ftyp = box("ftyp", new Uint8Array(8))

/** 伪造支持 Range 的静态文件服务：记录每次请求的 Range 头 */
function makeFetch(file: Uint8Array): {
  fetch: typeof fetch
  ranges: string[]
} {
  const ranges: string[] = []
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range") ?? ""
    ranges.push(range)
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)
    const start = match ? Number(match[1]) : 0
    const end = match ? Math.min(Number(match[2]), file.byteLength - 1) : file.byteLength - 1
    const slice = file.subarray(start, end + 1)
    return Promise.resolve(new Response(slice as unknown as BodyInit, { status: 206 }))
  }) as typeof fetch
  return { fetch: fetchImpl, ranges }
}

describe("probeMp4DurationSec", () => {
  it("moov 在文件头部：直接从首次范围请求解析 mvhd v0", async () => {
    const file = concat(ftyp, moov([mvhdV0(1000, 5966)]))
    const { fetch } = makeFetch(file)
    await expect(probeMp4DurationSec("https://space.example.com/a.mp4", fetch)).resolves.toBe(6)
  })

  it("mvhd version 1（64 位 duration）", async () => {
    const file = concat(ftyp, moov([mvhdV1(1000, 12_480)]))
    const { fetch } = makeFetch(file)
    await expect(probeMp4DurationSec("https://space.example.com/a.mp4", fetch)).resolves.toBe(12)
  })

  it("moov 在 mdat 之后（超出头部抓取范围）：逐个追 box 头定位后取 moov", async () => {
    const padding = new Uint8Array(80 * 1024) // mdat 占位，把 moov 推出 64KB 头部窗口
    const file = concat(ftyp, box("mdat", padding), moov([mvhdV0(600, 4470)]))
    const { fetch, ranges } = makeFetch(file)
    await expect(probeMp4DurationSec("https://space.example.com/a.mp4", fetch)).resolves.toBe(7)
    expect(ranges).toHaveLength(3)
    expect(ranges[0]).toBe("bytes=0-65535")
    expect(ranges[1]).toMatch(/^bytes=\d+-\d+$/) // mdat 之后的 box 头（16 字节）
    expect(ranges[2]).toMatch(/^bytes=\d+-\d+$/) // moov 载荷
  })

  it("毫秒时长四舍五入到整秒", async () => {
    const file = concat(ftyp, moov([mvhdV0(1000, 7499)]))
    const { fetch } = makeFetch(file)
    await expect(probeMp4DurationSec("https://space.example.com/a.mp4", fetch)).resolves.toBe(7)
  })

  it("非 MP4 内容（无顶层 box / 无 moov）返回 null", async () => {
    const { fetch } = makeFetch(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Uint8Array(100)]))
    await expect(probeMp4DurationSec("https://space.example.com/a.webm", fetch)).resolves.toBeNull()
  })

  it("请求失败 / 响应非 2xx 返回 null，不抛错", async () => {
    const failing = (() => Promise.resolve(new Response(null, { status: 403 }))) as typeof fetch
    await expect(
      probeMp4DurationSec("https://space.example.com/a.mp4", failing)
    ).resolves.toBeNull()
    const throwing = (() => Promise.reject(new Error("network down"))) as typeof fetch
    await expect(
      probeMp4DurationSec("https://space.example.com/a.mp4", throwing)
    ).resolves.toBeNull()
  })

  it("异常字段（timescale=0 / duration=0）返回 null", async () => {
    const zeroTimescale = concat(ftyp, moov([mvhdV0(0, 5000)]))
    const { fetch: fetchA } = makeFetch(zeroTimescale)
    await expect(probeMp4DurationSec("https://space.example.com/a.mp4", fetchA)).resolves.toBeNull()
    const zeroDuration = concat(ftyp, moov([mvhdV0(1000, 0)]))
    const { fetch: fetchB } = makeFetch(zeroDuration)
    await expect(probeMp4DurationSec("https://space.example.com/a.mp4", fetchB)).resolves.toBeNull()
  })
})
