/**
 * 生图尺寸 × 清晰度档位 · 通用生图管线 API 矩阵测试
 *
 * 对生图下拉中的每个模型 × 每个「比例×档位」（及 PRD 特殊尺寸 / 自定义像素）
 * 组合，走通用生图管线（src/image-generation）的对外 API 真实生成一次：
 *   - 常规比例×档位 → POST /api/image-generation/text-to-image（比例/档位 intent）
 *   - 特殊尺寸/自定义像素 → POST /api/image-generation/image-to-image
 *     （aspectRatio=custom + customAspectW/H + resolution=WxH，走像素级落位链路）
 * 每个用例记录 jobId、终态快照、网关就近适配（gatewayImage.adaptation）、
 * 实际交付尺寸（下载实测）、耗时、用量与错误原文，用于定位「某模型在某
 * 比例/档位/尺寸生成失败」的原因。特殊比例的适配处理（intent sizing、
 * 尺寸回退、归一/上采样）都发生在本仓库管线内，因此必须打 API 而非直连网关。
 *
 * ⚠️ 每个用例都真实消耗登录账号的积分（额度预检 fail-closed）：先 --dry-run
 * 看矩阵，再用 --filter/--ratios/--tiers 缩小范围，确认后加 --yes 放全量。
 *
 * 用法：
 *   TOKEN=<jwt> npx tsx scripts/test-image-generation-sizing.ts --dry-run
 *   TOKEN=<jwt> npx tsx scripts/test-image-generation-sizing.ts --filter=16:9@2K,1:1@4K
 *   TOKEN=<jwt> npx tsx scripts/test-image-generation-sizing.ts --models=ZQ-Image-2 --ratios=1:1 --yes
 *   TOKEN=<jwt> npx tsx scripts/test-image-generation-sizing.ts --sizes=all --yes
 *   npm run image-generation:size-test -- --dry-run     # 等价，自动带 .env
 *
 * 环境：
 *   TOKEN 必填（web 登录后的 auth_token，即后端 JWT）
 *   BASE 服务地址（默认 http://localhost:8000；测试环境填 https://api-dev.xxx）
 *   BFF=1 经 Next BFF 打（路径换成 /api/ai-creative/*，同时覆盖 BFF 转发层）
 *   REF_IMAGE 可选，i2i 用例的 main 参考图路径（缺省用脚本自造的合成图）
 *
 * 输出（默认 docs/references/，docs/** 被 gitignore，仅本地保留）：
 *   image-size-matrix-raw.json     按「模型|用例」键增量合并的全量明细（重跑只覆盖同键行）
 *   image-size-matrix-report.md    按模型分组的判定报告（含失败详情与终态快照）
 *
 * 判定口径（沿用 docs 前端仓库《生图尺寸与分辨率后端测试指南》§4 / PRD e2e）：
 *   pixels 用例=像素级命中；intent 用例=|宽/高−目标|<0.02（绝对差）且
 *   长边∈档位长边×[0.8, 1.15]。图片创作 generate 端点（SSE）不在本脚本
 *   范围，特殊尺寸的像素级链路由 i2i 同口径覆盖。
 */
import "dotenv/config"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { isSizeRelatedError } from "../src/image-generation/core/retry-utils"
import { TARGET_SIZE_REGISTRY } from "../src/image-generation/core/target-size-registry"

const STANDARD_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:4", "4:5"]
const TIER_LONG_EDGE: Record<string, number> = { "1K": 1024, "2K": 2048, "3K": 3072, "4K": 4096 }
const DEFAULT_PROMPT = "A clean studio product photo of a white ceramic coffee mug on a light gray background, soft lighting."

const POLL_INTERVAL_MS = 3_000
const DEFAULT_TIMEOUT_MS = 300_000
const DOWNLOAD_TIMEOUT_MS = 60_000

// ── 参数解析 ────────────────────────────────────────────────────────────────

const FLAG_ARGS = new Set(["--dry-run", "--yes", "--help", "--bff", "--report-only"])
const VALUE_ARGS = new Set([
  "--models", "--tiers", "--ratios", "--sizes", "--sizes-tier", "--custom", "--filter", "--prompt", "--timeout-ms", "--out-dir", "--ref",
])

function parseArgs(argv: string[]) {
  const opts: Record<string, string> = {}
  const on = new Set<string>()
  for (const arg of argv) {
    if (FLAG_ARGS.has(arg)) {
      on.add(arg)
      continue
    }
    const eq = arg.indexOf("=")
    const head = eq === -1 ? arg : arg.slice(0, eq)
    if (!VALUE_ARGS.has(head)) throw new Error(`不支持的参数 ${arg}，--help 查看用法`)
    if (eq === -1 || !arg.slice(eq + 1)) throw new Error(`${head} 需要 =值 形式`)
    if (opts[head]) throw new Error(`${head} 只能指定一次`)
    opts[head] = arg.slice(eq + 1)
  }
  return {
    opts,
    dryRun: on.has("--dry-run"),
    yes: on.has("--yes"),
    help: on.has("--help"),
    bff: on.has("--bff"),
    reportOnly: on.has("--report-only"),
  }
}

function printUsage() {
  console.log(`用法：TOKEN=<jwt> npx tsx scripts/test-image-generation-sizing.ts [选项]

  --models=a,b       覆盖目录，直接指定 provider/model id（跳过 models 接口）
  --tiers=1K,2K,4K   档位子集（默认 1K,2K,4K；可含 3K 做历史兼容回归）
  --ratios=16:9,1:1  比例子集（默认 10 个标准比例）
  --sizes=all|B-01,A-01  PRD 特殊尺寸（24 槽位，走 i2i 像素链路，默认关闭）
  --sizes-tier=2K    特殊尺寸用例的档位（默认 2K——档位只决定渲染质量组，与像素目标无关）
  --custom=1200x800  附加自定义像素尺寸（逗号分隔多个，走 i2i）
  --filter=16:9@2K,B-01  跨全集的最终过滤（精确匹配用例 ID）
  --prompt=...       覆盖测试 prompt
  --ref=...          i2i 用例的 main 参考图路径（缺省自造合成图）
  --timeout-ms=...   单用例轮询上限（默认 ${DEFAULT_TIMEOUT_MS}）
  --out-dir=...      报告目录（默认 docs/references）
  --bff              经 Next BFF 打（路径 /api/ai-creative/*，需 BASE 指向 web 端口）
  --dry-run          只打印矩阵不提交
  --yes              用例数 >3 时跳过确认门直接执行
  --report-only      不跑测试，仅从既有 raw JSON 再生成 markdown 报告

环境：TOKEN 必填；BASE 默认 http://localhost:8000；BFF=1 等价 --bff。
用例 ID：比例档位=「比例@档位」（如 16:9@2K）；PRD 尺寸=槽位号（如 B-01）；
自定义像素=「custom-宽x高」。判定口径：pixels 用例要求像素级命中；intent
用例 |宽/高−目标| < 0.02（沿用 PRD e2e 绝对差口径）且长边∈档位长边×[0.8,1.15]。`)
}

// ── API 客户端 ──────────────────────────────────────────────────────────────

class PipelineApi {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly bff: boolean,
  ) {}

  /** kind: t2i | i2i → 直连 /api/image-generation/<kind>，BFF /api/ai-creative/<kind> */
  url(kind: "t2i" | "i2i", jobId?: string): string {
    const segment = this.bff ? "api/ai-creative" : "api/image-generation"
    const path = kind === "t2i" ? "text-to-image" : "image-to-image"
    return `${this.base.replace(/\/$/, "")}/${segment}/${path}${jobId ? `/${jobId}` : ""}`
  }

  modelsUrl(): string {
    const segment = this.bff ? "api/ai-creative" : "api/image-generation"
    return `${this.base.replace(/\/$/, "")}/${segment}/models`
  }

  async request(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
    const response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(120_000),
    })
    const text = await response.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      // 保留原文
    }
    return { ok: response.ok, status: response.status, body }
  }
}

interface TestModel {
  id: string
  label: string
}

async function loadModels(api: PipelineApi, override?: string[]): Promise<TestModel[]> {
  if (override?.length) return override.map(id => ({ id, label: id }))
  const result = await api.request(api.modelsUrl())
  if (!result.ok) {
    const error = (result.body as { error?: string } | undefined)?.error
    throw new Error(`GET models 失败 HTTP ${result.status}${error ? `：${error}` : ""}`)
  }
  const list = result.body as Array<{ id?: string; label?: string }>
  const models = list.filter((m): m is { id: string; label?: string } => typeof m.id === "string")
  if (!models.length) throw new Error("models 接口返回为空（目录未上架或 BFF/后端未就绪）")
  return models.map(m => ({ id: m.id, label: m.label ?? m.id }))
}

// ── 用例矩阵 ────────────────────────────────────────────────────────────────

type SizingIntent = { kind: "intent"; caseId: string; ratio: string; tier: string }
type SizingPixels = { kind: "pixels"; caseId: string; w: number; h: number }
type Sizing = SizingIntent | SizingPixels

function buildSizings(opts: Record<string, string>): Sizing[] {
  const out: Sizing[] = []
  const seen = new Set<string>()

  const push = (sizing: Sizing) => {
    if (seen.has(sizing.caseId)) throw new Error(`用例 ID 重复：${sizing.caseId}`)
    seen.add(sizing.caseId)
    out.push(sizing)
  }

  const tiers = (opts["--tiers"] ?? "1K,2K,4K").split(",").map(t => t.trim().toUpperCase()).filter(Boolean)
  for (const tier of tiers) {
    if (!(tier in TIER_LONG_EDGE)) throw new Error(`不支持的档位 ${tier}（可选 ${Object.keys(TIER_LONG_EDGE).join("/")}）`)
  }
  const ratios = (opts["--ratios"] ?? STANDARD_RATIOS.join(",")).split(",").map(r => r.trim()).filter(Boolean)
  for (const ratio of ratios) {
    if (!/^\d{1,5}:\d{1,5}$/.test(ratio)) throw new Error(`比例格式不合法：${ratio}（应为 宽:高）`)
  }
  for (const ratio of ratios) {
    for (const tier of tiers) {
      push({ kind: "intent", caseId: `${ratio}@${tier}`, ratio, tier })
    }
  }

  if (opts["--sizes"]) {
    const want = opts["--sizes"] === "all" ? null : new Set(opts["--sizes"].split(",").map(s => s.trim()).filter(Boolean))
    if (want) {
      const known = new Set(TARGET_SIZE_REGISTRY.map(s => s.id))
      for (const id of want) {
        if (!known.has(id)) throw new Error(`未知 PRD 槽位 ${id}（可用：${[...known].join(",")}）`)
      }
    }
    for (const slot of TARGET_SIZE_REGISTRY) {
      if (!want || want.has(slot.id)) push({ kind: "pixels", caseId: slot.id, w: slot.width, h: slot.height })
    }
  }

  if (opts["--custom"]) {
    for (const raw of opts["--custom"].split(",").map(s => s.trim()).filter(Boolean)) {
      const match = raw.match(/^(\d{2,5})x(\d{2,5})$/i)
      if (!match) throw new Error(`自定义尺寸格式不合法：${raw}（应为 宽x高）`)
      const w = Number(match[1])
      const h = Number(match[2])
      if (w < 64 || h < 64 || w > 8192 || h > 8192) {
        throw new Error(`自定义尺寸超出范围：${raw}（管线接受 64~8192）`)
      }
      push({ kind: "pixels", caseId: `custom-${w}x${h}`, w, h })
    }
  }

  if (opts["--filter"]) {
    const keep = new Set(opts["--filter"].split(",").map(s => s.trim()).filter(Boolean))
    for (const id of keep) {
      if (!seen.has(id)) throw new Error(`--filter 中的用例不在矩阵内：${id}`)
    }
    return out.filter(s => keep.has(s.caseId))
  }
  return out
}

// ── 判定 ────────────────────────────────────────────────────────────────────

function expectedDims(sizing: Sizing): { width: number; height: number } {
  if (sizing.kind === "pixels") return { width: sizing.w, height: sizing.h }
  const [rw, rh] = sizing.ratio.split(":").map(Number)
  const long = TIER_LONG_EDGE[sizing.tier]
  return rw >= rh
    ? { width: long, height: Math.round((long * rh) / rw) }
    : { width: Math.round((long * rw) / rh), height: long }
}

interface Verdict {
  tag: string
  aspectDeltaPct?: number
  longEdgeDeltaPct?: number
}

function judge(sizing: Sizing, width: number, height: number): Verdict {
  const expected = expectedDims(sizing)
  const targetRatio = expected.width / expected.height
  const actualRatio = width / height
  const aspectDeltaPct = (Math.abs(actualRatio - targetRatio) / targetRatio) * 100
  // 比例差沿用 PRD e2e 口径：绝对差 < 0.02（相对百分比仅作展示）
  const aspectOk = Math.abs(actualRatio - targetRatio) < 0.02
  if (sizing.kind === "pixels") {
    if (width === sizing.w && height === sizing.h) return { tag: "✅ 像素命中", aspectDeltaPct }
    if (aspectOk) return { tag: "🟡 比例对（像素不符）", aspectDeltaPct }
    return { tag: "🟠 比例错", aspectDeltaPct }
  }
  const long = Math.max(width, height)
  const expectedLong = TIER_LONG_EDGE[sizing.tier]
  const longEdgeDeltaPct = ((long - expectedLong) / expectedLong) * 100
  if (!aspectOk) return { tag: "🟠 比例错", aspectDeltaPct, longEdgeDeltaPct }
  if (long < expectedLong * 0.8 || long > expectedLong * 1.15) {
    return { tag: "⚠️ 档位偏差", aspectDeltaPct, longEdgeDeltaPct }
  }
  return { tag: "✅ 比例/档位", aspectDeltaPct, longEdgeDeltaPct }
}

// ── 记录形状 ────────────────────────────────────────────────────────────────

interface CaseError {
  stage: "submit" | "poll" | "terminal" | "download"
  status?: number
  message: string
  sizeRelated: boolean
}

interface CaseRow {
  key: string
  model: string
  caseId: string
  kind: "intent" | "pixels"
  endpoint: "t2i" | "i2i"
  request: Record<string, unknown>
  jobId?: string
  /** 终态（t2i done/error；i2i completed/failed；脚本级 submit-error/poll-timeout/poll-error/no-artifact） */
  status: string
  /** 最后一次轮询快照原文（定位失败原因的第一手材料） */
  snapshot?: unknown
  /** 网关回显尺寸（快照 gatewayImage.width/height） */
  gatewayDims?: { width: number; height: number }
  /** 下载产物实测尺寸（判定依据） */
  delivered?: { width: number; height: number; format?: string; bytes?: number }
  expected?: { width: number; height: number }
  verdict: Verdict
  /** t2i usage / i2i tokenUsage 快照原文 */
  usageRaw?: unknown
  totalMs?: number
  polls?: number
  error?: CaseError
  recordedAt: string
}

function httpError(stage: CaseError["stage"], status: number | undefined, body: unknown): CaseError {
  const shaped = body as { error?: string } | undefined
  const message = shaped?.error ?? (typeof body === "string" ? body : JSON.stringify(body ?? ""))
  const text = message || `HTTP ${status ?? "?"}`
  return { stage, status, message: text.slice(0, 500), sizeRelated: isSizeRelatedError(text) }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** 从快照 gatewayImage 提取网关回显尺寸与 adaptation（t2i/i2i 同形）。 */
function gatewayImageOf(snapshot: unknown): { width?: number; height?: number; adaptation?: unknown } | undefined {
  const shaped = snapshot as { gatewayImage?: { width?: unknown; height?: unknown; adaptation?: unknown } } | undefined
  const image = shaped?.gatewayImage
  if (!image) return undefined
  return {
    width: typeof image.width === "number" ? image.width : undefined,
    height: typeof image.height === "number" ? image.height : undefined,
    adaptation: image.adaptation,
  }
}

async function downloadImage(url: string): Promise<NonNullable<CaseRow["delivered"]>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`下载产物 HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const metadata = await sharp(buffer).metadata()
  return { width: metadata.width ?? 0, height: metadata.height ?? 0, format: metadata.format, bytes: buffer.length }
}

// ── 单用例执行 ──────────────────────────────────────────────────────────────

interface RunContext {
  api: PipelineApi
  prompt: string
  timeoutMs: number
  sizesTier: string
  mainRef: { buffer: Buffer; mime: string }
}

async function pollUntilTerminal(
  api: PipelineApi,
  kind: "t2i" | "i2i",
  jobId: string,
  timeoutMs: number,
): Promise<
  | { ok: true; snapshot: unknown; polls: number }
  | { ok: false; status: "poll-timeout" | "poll-error"; error: CaseError; snapshot?: unknown; polls: number }
> {
  const deadline = Date.now() + timeoutMs
  let polls = 0
  let last: unknown
  for (;;) {
    if (Date.now() >= deadline) {
      return {
        ok: false,
        status: "poll-timeout",
        snapshot: last,
        polls,
        error: { stage: "poll", message: `超过 ${timeoutMs}ms 未到终态`, sizeRelated: false },
      }
    }
    await sleep(POLL_INTERVAL_MS)
    let response: Awaited<ReturnType<PipelineApi["request"]>>
    try {
      response = await api.request(api.url(kind, jobId))
    } catch (err) {
      polls++
      // 网络抖动继续轮；到截止自然超时
      if (Date.now() >= deadline) {
        return { ok: false, status: "poll-error", snapshot: last, polls, error: httpError("poll", undefined, String(err)) }
      }
      continue
    }
    polls++
    if (response.status === 404) {
      // 任务过期/不存在（保留窗口 30 分钟）——直接终态
      return { ok: false, status: "poll-error", snapshot: last, polls, error: httpError("poll", 404, response.body) }
    }
    if (!response.ok) {
      // 4xx/5xx：鉴权类错误重试无意义，直接终止
      return { ok: false, status: "poll-error", snapshot: last, polls, error: httpError("poll", response.status, response.body) }
    }
    last = response.body
    const snapshot = response.body as { status?: string }
    if (kind === "t2i") {
      if (snapshot.status === "done" || snapshot.status === "error") return { ok: true, snapshot: last, polls }
    } else if (snapshot.status === "completed" || snapshot.status === "failed") {
      return { ok: true, snapshot: last, polls }
    }
  }
}

async function finishSucceeded(
  base: Omit<CaseRow, "status" | "verdict" | "gatewayDims" | "delivered" | "expected" | "usageRaw" | "error">,
  sizing: Sizing,
  snapshot: unknown,
  url: string | undefined,
  usageRaw: unknown,
  totalMs: number,
  polls: number,
): Promise<CaseRow> {
  if (!url) {
    return {
      ...base, status: "no-artifact", snapshot, totalMs, polls,
      error: { stage: "terminal", message: "终态成功但快照未携带图片 URL", sizeRelated: false },
      verdict: { tag: "❌ 无产物" },
    }
  }
  const gateway = gatewayImageOf(snapshot)
  let delivered: CaseRow["delivered"]
  let error: CaseError | undefined
  try {
    delivered = await downloadImage(url)
  } catch (err) {
    // 下载失败不算生成失败：用网关回显兜底判定，错误照记
    if (gateway?.width && gateway.height) delivered = { width: gateway.width, height: gateway.height }
    error = {
      stage: "download",
      message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      sizeRelated: false,
    }
  }
  return {
    ...base,
    status: "succeeded",
    snapshot,
    // 网关未回显宽高时不记（避免 0x0 假数据混入回显比对）
    ...(gateway?.width && gateway.height
      ? { gatewayDims: { width: gateway.width, height: gateway.height } }
      : {}),
    ...(delivered ? { delivered } : {}),
    expected: expectedDims(sizing),
    verdict: delivered ? judge(sizing, delivered.width, delivered.height) : { tag: "❓ 无法判定" },
    ...(usageRaw !== undefined ? { usageRaw } : {}),
    ...(error ? { error } : {}),
    totalMs,
    polls,
  }
}

async function runT2ICase(ctx: RunContext, model: string, sizing: SizingIntent): Promise<CaseRow> {
  const base = {
    key: `${model}|${sizing.caseId}`,
    model,
    caseId: sizing.caseId,
    kind: "intent" as const,
    endpoint: "t2i" as const,
    request: { provider: model, prompt: ctx.prompt, aspectRatio: sizing.ratio, resolutionTier: sizing.tier },
    recordedAt: new Date().toISOString(),
  }
  const started = Date.now()

  let created: Awaited<ReturnType<PipelineApi["request"]>>
  try {
    created = await ctx.api.request(ctx.api.url("t2i"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(base.request),
    })
  } catch (err) {
    return { ...base, status: "submit-error", verdict: { tag: "❌ 提交失败" }, totalMs: Date.now() - started, error: httpError("submit", undefined, String(err)) }
  }
  if (!created.ok) {
    return { ...base, status: "submit-error", verdict: { tag: "❌ 提交失败" }, totalMs: Date.now() - started, error: httpError("submit", created.status, created.body) }
  }
  const jobId = (created.body as { jobId?: string }).jobId
  if (!jobId) {
    return { ...base, status: "submit-error", verdict: { tag: "❌ 提交失败" }, snapshot: created.body, totalMs: Date.now() - started, error: httpError("submit", created.status, "响应缺少 jobId") }
  }

  const polled = await pollUntilTerminal(ctx.api, "t2i", jobId, ctx.timeoutMs)
  const common = { ...base, jobId }
  if (!polled.ok) {
    return { ...common, status: polled.status, snapshot: polled.snapshot, totalMs: Date.now() - started, polls: polled.polls, error: polled.error, verdict: { tag: "❌ 轮询失败" } }
  }
  const snapshot = polled.snapshot as { status?: string; url?: string; error?: string; usage?: unknown }
  if (snapshot.status === "error") {
    const message = snapshot.error ?? "生成失败"
    return {
      ...common, status: "error", snapshot, totalMs: Date.now() - started, polls: polled.polls,
      verdict: { tag: "❌ 生成失败" },
      error: { stage: "terminal", message: message.slice(0, 500), sizeRelated: isSizeRelatedError(message) },
    }
  }
  return finishSucceeded(common, sizing, snapshot, snapshot.url, snapshot.usage, Date.now() - started, polled.polls)
}

async function runI2ICase(ctx: RunContext, model: string, sizing: SizingPixels): Promise<CaseRow> {
  // 与 i2i 控制器契约一致：multipart 单 form JSON 字段 + main 参考图文件；
  // resolutionTier 显式传（normalizeResolutionTier 显式优先），resolution 同发像素
  const form = {
    mode: "normal",
    prompt: ctx.prompt,
    provider: model,
    aspectRatio: "custom",
    customAspectW: sizing.w,
    customAspectH: sizing.h,
    resolutionTier: ctx.sizesTier,
    resolution: `${sizing.w}x${sizing.h}`,
    count: 1,
  }
  const base = {
    key: `${model}|${sizing.caseId}`,
    model,
    caseId: sizing.caseId,
    kind: "pixels" as const,
    endpoint: "i2i" as const,
    request: form,
    recordedAt: new Date().toISOString(),
  }
  const started = Date.now()

  const multipart = new FormData()
  multipart.append("form", JSON.stringify(form))
  // Buffer→独立 ArrayBuffer：Node Buffer 底层可能是 SharedArrayBuffer，不满足 BlobPart 类型
  const refView = new Uint8Array(ctx.mainRef.buffer.byteLength)
  refView.set(ctx.mainRef.buffer)
  multipart.append("main", new Blob([refView.buffer], { type: ctx.mainRef.mime }), "reference.png")

  let created: Awaited<ReturnType<PipelineApi["request"]>>
  try {
    created = await ctx.api.request(ctx.api.url("i2i"), { method: "POST", body: multipart })
  } catch (err) {
    return { ...base, status: "submit-error", verdict: { tag: "❌ 提交失败" }, totalMs: Date.now() - started, error: httpError("submit", undefined, String(err)) }
  }
  if (!created.ok) {
    return { ...base, status: "submit-error", verdict: { tag: "❌ 提交失败" }, snapshot: created.body, totalMs: Date.now() - started, error: httpError("submit", created.status, created.body) }
  }
  const jobId = (created.body as { jobId?: string }).jobId
  if (!jobId) {
    return { ...base, status: "submit-error", verdict: { tag: "❌ 提交失败" }, snapshot: created.body, totalMs: Date.now() - started, error: httpError("submit", created.status, "响应缺少 jobId") }
  }

  const polled = await pollUntilTerminal(ctx.api, "i2i", jobId, ctx.timeoutMs)
  const common = { ...base, jobId }
  if (!polled.ok) {
    return { ...common, status: polled.status, snapshot: polled.snapshot, totalMs: Date.now() - started, polls: polled.polls, error: polled.error, verdict: { tag: "❌ 轮询失败" } }
  }
  const snapshot = polled.snapshot as {
    status?: string
    errorMessage?: string
    tokenUsage?: unknown
    images?: Array<{ index?: number; status?: string; url?: string; errorMessage?: string; gatewayImage?: unknown }>
  }
  const image = [...(snapshot.images ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0]
  if (snapshot.status === "failed" || image?.status === "failed") {
    const message = image?.errorMessage ?? snapshot.errorMessage ?? "生成失败"
    return {
      ...common, status: "failed", snapshot, totalMs: Date.now() - started, polls: polled.polls,
      verdict: { tag: "❌ 生成失败" },
      error: { stage: "terminal", message: message.slice(0, 500), sizeRelated: isSizeRelatedError(message) },
    }
  }
  // 单图 i2i：把首图 gatewayImage 拍平到快照顶层复用 finishSucceeded 的提取逻辑
  const flattened = image?.gatewayImage ? { ...snapshot, gatewayImage: image.gatewayImage } : snapshot
  return finishSucceeded(common, sizing, flattened, image?.url, snapshot.tokenUsage, Date.now() - started, polled.polls)
}

/** 特殊尺寸的档位只决定渲染质量组（高清/基础），与像素目标无关——缺省 2K。 */

// ── i2i 参考图 ──────────────────────────────────────────────────────────────

async function loadMainReference(path?: string): Promise<{ buffer: Buffer; mime: string }> {
  if (path) {
    const buffer = readFileSync(path)
    const mime = /\.(jpe?g)$/i.test(path) ? "image/jpeg" : "image/png"
    return { buffer, mime }
  }
  // 自造合成参考图：渐变底 + 简单主体图形，足够 img2img 通道使用
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#e8eaef"/><stop offset="100%" stop-color="#c9cdd8"/>
    </linearGradient></defs>
    <rect width="1024" height="1024" fill="url(#bg)"/>
    <ellipse cx="512" cy="560" rx="260" ry="230" fill="#f7f8fa" stroke="#aeb4c2" stroke-width="6"/>
    <rect x="420" y="250" width="184" height="150" rx="24" fill="#ffffff" stroke="#aeb4c2" stroke-width="6"/>
    <circle cx="512" cy="470" r="42" fill="#d8dbe4"/>
  </svg>`
  return { buffer: await sharp(Buffer.from(svg)).png().toBuffer(), mime: "image/png" }
}

// ── 报告 ────────────────────────────────────────────────────────────────────

function mergePrior(fresh: CaseRow[], rawPath: string): { merged: CaseRow[]; priorCount: number } {
  const byKey = new Map<string, CaseRow>()
  let priorCount = 0
  if (existsSync(rawPath)) {
    try {
      const prior = JSON.parse(readFileSync(rawPath, "utf8")) as CaseRow[]
      if (Array.isArray(prior)) {
        for (const row of prior) {
          if (row?.key) byKey.set(row.key, row)
        }
        priorCount = byKey.size
      }
    } catch (err) {
      throw new Error(`既有 raw JSON 解析失败（${rawPath}）：${err instanceof Error ? err.message : err}`)
    }
  }
  const merged: CaseRow[] = [...byKey.values()]
  for (const row of fresh) {
    const index = merged.findIndex(r => r.key === row.key)
    if (index === -1) merged.push(row)
    else merged[index] = row
  }
  return { merged, priorCount }
}

function esc(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function requestSummary(row: CaseRow): string {
  if (row.kind === "pixels") {
    const form = row.request as { customAspectW?: number; customAspectH?: number; resolutionTier?: string }
    return `custom ${form.customAspectW}x${form.customAspectH} tier=${form.resolutionTier}`
  }
  const body = row.request as { aspectRatio?: string; resolutionTier?: string }
  return `ar=${body.aspectRatio} tier=${body.resolutionTier}`
}

function adaptationSummary(row: CaseRow): string {
  const adaptation = gatewayImageOf(row.snapshot)?.adaptation as
    | { requested?: { size?: string; aspect_ratio?: string; resolution?: string }; actual?: { size?: string }; changes?: string[] }
    | undefined
  if (!adaptation) return "—"
  const from = adaptation.requested?.size ?? adaptation.requested?.aspect_ratio ?? adaptation.requested?.resolution ?? "?"
  const to = adaptation.actual?.size ?? "?"
  const changes = (adaptation.changes ?? []).join("; ")
  return `${from}→${to}${changes ? `（${changes}）` : ""}`
}

function dimsMismatch(row: CaseRow): boolean {
  return Boolean(
    row.gatewayDims && row.delivered && (row.gatewayDims.width !== row.delivered.width || row.gatewayDims.height !== row.delivered.height),
  )
}

interface ReportMeta {
  base: string
  viaBff: boolean
  prompt: string
  runCount: number
  priorCount: number
}

function writeReport(merged: CaseRow[], meta: ReportMeta, rawPath: string, mdPath: string) {
  const byModel = new Map<string, CaseRow[]>()
  for (const row of merged) {
    const list = byModel.get(row.model) ?? []
    list.push(row)
    byModel.set(row.model, list)
  }

  const lines: string[] = []
  lines.push("# 生图尺寸 × 清晰度档位 · 通用生图管线测试报告", "")
  lines.push(`- 生成时间：${new Date().toISOString()}`)
  lines.push(`- 入口：${meta.viaBff ? `${meta.base}（经 Next BFF /api/ai-creative）` : `${meta.base}/api/image-generation（直连后端）`}`)
  lines.push(`- Prompt：${meta.prompt}`)
  lines.push("- 链路：常规比例×档位 → text-to-image（intent）；特殊/自定义尺寸 → image-to-image（custom 像素，要求像素级命中）")
  lines.push("- 判定口径：pixels=像素级命中；intent=|宽/高−目标|<0.02（沿用 PRD e2e 绝对差口径）且长边∈档位长边×[0.8,1.15]；实际尺寸列为下载产物实测，与网关回显不一致时以 ⚠️ 标注")
  lines.push(`- 数据：按「模型|用例」合并自历史运行（本次更新 ${meta.runCount} 行，历史保留 ${meta.priorCount} 行；单行 recordedAt 为写入时间）`)
  lines.push(`- 明细（含终态快照/错误原文）：\`${rawPath}\``, "")

  lines.push("## 汇总", "")
  lines.push("| 模型 | 用例 | ✅ | 🟡/⚠️ | 🟠 | ❌ | ❓ |", "|---|---:|---:|---:|---:|---:|---:|")
  const buckets = ["✅", "🟡", "⚠️", "🟠", "❌", "❓"]
  for (const [model, rows] of byModel) {
    const counts = buckets.map(tag => rows.filter(r => r.verdict.tag.startsWith(tag)).length)
    lines.push(`| ${model} | ${rows.length} | ${counts[0]} | ${counts[1] + counts[2]} | ${counts[3]} | ${counts[4]} | ${counts[5]} |`)
  }
  lines.push("")

  for (const [model, rows] of byModel) {
    lines.push(`## ${model}`, "")
    lines.push("| 用例 | 链路 | 请求 | 终态 | 实际尺寸 | 期望 | 网关适配 | 耗时s | 判定 | 记录时间 |")
    lines.push("|---|---|---|---|---|---|---|---:|---|---|")
    for (const row of rows) {
      const delivered = row.delivered
        ? `${row.delivered.width}x${row.delivered.height}${dimsMismatch(row) ? ` ⚠️回显${row.gatewayDims?.width}x${row.gatewayDims?.height}` : ""}`
        : "—"
      const expected = row.expected ? `${row.expected.width}x${row.expected.height}` : "—"
      const errorBrief = row.error ? `<br>**${esc(truncate(row.error.message, 120))}**` : ""
      lines.push(
        `| ${row.caseId} | ${row.endpoint} | ${esc(requestSummary(row))} | ${row.status} | ${delivered} | ${expected} | ${esc(truncate(adaptationSummary(row), 60))} | ${((row.totalMs ?? 0) / 1000).toFixed(1)} | ${row.verdict.tag}${errorBrief} | ${row.recordedAt.slice(0, 16)} |`,
      )
    }
    lines.push("")
  }

  const failures = merged.filter(r => r.status !== "succeeded" || r.verdict.tag.startsWith("❌"))
  if (failures.length) {
    lines.push("## 失败详情", "")
    for (const row of failures) {
      lines.push(`### ${row.model} · ${row.caseId}（${row.status}）`, "")
      lines.push(`- 判定：${row.verdict.tag} · 链路：${row.endpoint} · jobId：${row.jobId ?? "—"}`)
      lines.push(`- 请求：\`${JSON.stringify(row.request)}\``)
      if (row.error) {
        lines.push(`- error：stage=${row.error.stage}${row.error.status ? ` status=${row.error.status}` : ""} sizeRelated=${row.error.sizeRelated}`)
        lines.push(`  - message：${esc(row.error.message)}`)
      }
      if (row.snapshot) lines.push(`- 终态快照：\`${truncate(JSON.stringify(row.snapshot), 1200)}\``)
      lines.push("")
    }
  }
  writeFileSync(mdPath, `${lines.join("\n")}\n`)
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const { opts, dryRun, yes, help, bff: bffFlag, reportOnly } = parseArgs(process.argv.slice(2))
  if (help) {
    printUsage()
    return
  }
  if (reportOnly) {
    // 只从既有 raw JSON 再生成报告（不提交任务、不需要 TOKEN）
    const outDir = opts["--out-dir"] ?? "docs/references"
    const rawPath = join(outDir, "image-size-matrix-raw.json")
    const mdPath = join(outDir, "image-size-matrix-report.md")
    if (!existsSync(rawPath)) throw new Error(`未找到 ${rawPath}，先跑一次测试`)
    const merged = JSON.parse(readFileSync(rawPath, "utf8")) as CaseRow[]
    if (!Array.isArray(merged) || !merged.length) throw new Error(`${rawPath} 无有效数据`)
    writeReport(merged, { base: "—（--report-only 再生成）", viaBff: false, prompt: "—", runCount: 0, priorCount: merged.length }, rawPath, mdPath)
    console.log(`报告已再生成：${mdPath}（共 ${merged.length} 行）`)
    return
  }
  const viaBff = bffFlag || process.env.BFF === "1"
  const base = process.env.BASE ?? (viaBff ? "http://localhost:4000" : "http://localhost:8000")
  const token = process.env.TOKEN?.trim()
  if (!token) throw new Error("缺少 TOKEN=<jwt>（web 登录后的 auth_token）")

  const sizings = buildSizings(opts)
  if (!sizings.length) throw new Error("矩阵为空：检查 --filter/--ratios/--tiers 参数")
  const prompt = opts["--prompt"] ?? DEFAULT_PROMPT
  const timeoutMs = Number(opts["--timeout-ms"] ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000) throw new Error("--timeout-ms 至少 30000")
  const sizesTier = opts["--sizes-tier"]?.trim().toUpperCase() ?? "2K"
  if (!(sizesTier in TIER_LONG_EDGE)) throw new Error(`--sizes-tier 只支持 ${Object.keys(TIER_LONG_EDGE).join("/")}`)

  const api = new PipelineApi(base, token, viaBff)
  const models = await loadModels(api, opts["--models"]?.split(",").map(s => s.trim()).filter(Boolean))

  const total = models.length * sizings.length
  console.log(`入口：${viaBff ? `${base} /api/ai-creative（BFF）` : `${base} /api/image-generation（直连）`}`)
  console.log(`模型 ${models.length} 个 × 用例 ${sizings.length} 个 = ${total} 个组合（⚠️ 真实消耗积分）：`)
  for (const model of models) console.log(`  - ${model.id}（${model.label}）`)
  console.log(`用例：${sizings.map(s => s.caseId).join(", ")}\n`)

  if (dryRun) {
    console.log("--dry-run：未提交任何任务。确认后去掉 --dry-run 执行（>3 个用例需加 --yes）。")
    return
  }
  if (total > 3 && !yes) {
    console.error(`⚠️ 将真实提交 ${total} 个生成任务（消耗登录账号积分）。确认后加 --yes 执行，或先用 --filter/--ratios/--tiers 缩小范围。`)
    process.exitCode = 1
    return
  }

  const mainRef = sizings.some(s => s.kind === "pixels")
    ? await loadMainReference(opts["--ref"] ?? process.env.REF_IMAGE)
    : { buffer: Buffer.alloc(0), mime: "image/png" }
  const ctx: RunContext = { api, prompt, timeoutMs, sizesTier, mainRef }

  const rows: CaseRow[] = []
  for (const model of models) {
    for (const sizing of sizings) {
      process.stdout.write(`[${rows.length + 1}/${total}] ${model.id} ${sizing.caseId} ... `)
      const row =
        sizing.kind === "intent"
          ? await runT2ICase(ctx, model.id, sizing)
          : await runI2ICase(ctx, model.id, sizing)
      rows.push(row)
      const delivered = row.delivered ? `${row.delivered.width}x${row.delivered.height}` : "—"
      console.log(`${row.verdict.tag} ${delivered} ${((row.totalMs ?? 0) / 1000).toFixed(1)}s`)
    }
  }

  const outDir = opts["--out-dir"] ?? "docs/references"
  mkdirSync(outDir, { recursive: true })
  const rawPath = join(outDir, "image-size-matrix-raw.json")
  const mdPath = join(outDir, "image-size-matrix-report.md")
  const { merged, priorCount } = mergePrior(rows, rawPath)
  writeFileSync(rawPath, `${JSON.stringify(merged, null, 2)}\n`)
  writeReport(merged, { base, viaBff, prompt, runCount: rows.length, priorCount }, rawPath, mdPath)

  const passed = rows.filter(r => r.verdict.tag.startsWith("✅")).length
  const failed = rows.filter(r => r.verdict.tag.startsWith("❌")).length
  console.log(`\n本次 ${rows.length} 例：✅ ${passed} · 🟡/⚠️/🟠 ${rows.length - passed - failed} · ❌ ${failed}`)
  if (failed) {
    console.log(`失败用例：${rows.filter(r => r.verdict.tag.startsWith("❌")).map(r => `${r.model} ${r.caseId}（${r.error?.message.slice(0, 60) ?? r.status}）`).join("；")}`)
  }
  console.log(`报告：${mdPath}\n明细：${rawPath}`)
  process.exitCode = failed ? 1 : 0
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
