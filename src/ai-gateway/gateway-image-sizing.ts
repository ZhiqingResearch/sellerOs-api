import { BadRequestException } from "@nestjs/common"

/** Gateway 接收尺寸意图，旧目录中的上游尺寸枚举不再约束公共请求。
 *  2026-09-14：全目录 resolution 枚举收窄为 1k/2k/4k（3K 已下线）。 */
export function gatewayImageSizingSchema(schema: Record<string, unknown>) {
  const original = schema
  const seen = new Set<string>()
  while (typeof schema.$ref === "string") {
    const ref = schema.$ref
    if (!ref.startsWith("#/") || seen.has(ref)) throw new Error("请求 Schema 根引用无效")
    seen.add(ref)
    let target: unknown = original
    for (const key of ref.slice(2).split("/"))
      target = (target as Record<string, unknown>)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")]
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("请求 Schema 根引用不存在")
    const rest = { ...schema }
    delete rest.$ref
    const resolved = target as Record<string, unknown>
    schema = {
      ...resolved, ...rest,
      properties: { ...(resolved.properties as object), ...(rest.properties as object) },
      required: [...new Set([...(resolved.required as string[] ?? []), ...(rest.required as string[] ?? [])])],
    }
  }
  return {
    ...schema,
    required: Array.isArray(schema.required)
      ? schema.required.filter(key => !["size", "resolution", "aspect_ratio"].includes(key))
      : [],
    properties: {
      ...(schema.properties as Record<string, unknown>),
      aspect_ratio: { type: "string", pattern: "^[1-9][0-9]*:[1-9][0-9]*$" },
      resolution: { type: "string", enum: ["1k", "2k", "4k"] },
      strict: { type: "boolean" },
      size: { type: "string", pattern: "^[1-9][0-9]*x[1-9][0-9]*$" },
    },
  }
}

export function normalizeGatewayImageSizing(params: Record<string, unknown>) {
  const result = { ...params }
  // 兼容历史 model_params 把像素放在 resolution、把档位放在 size。
  if (typeof result.resolution === "string" && /^\d+[x×*]\d+$/i.test(result.resolution)) {
    const size = result.resolution.replace(/[×*X]/g, "x")
    if (result.size !== undefined && result.size !== size)
      throw new BadRequestException("size 与 resolution 的像素尺寸冲突")
    result.size = size
    delete result.resolution
  }
  if (typeof result.size === "string" && /^[1-4]k$/i.test(result.size)) {
    if (
      result.resolution !== undefined &&
      String(result.resolution).toLowerCase() !== result.size.toLowerCase()
    )
      throw new BadRequestException("size 与 resolution 的清晰度档位冲突")
    result.resolution = result.size
    delete result.size
  }
  if (result.resolution !== undefined) {
    if (typeof result.resolution !== "string" || !/^[1-4]k$/i.test(result.resolution))
      throw new BadRequestException("清晰度档位格式不合法")
    // 2026-09-14 全目录 resolution 枚举仅 1k/2k/4k：3k 在网关准入层必 400，
    // 本地镜像同口径拦截，给出更早更明确的错误。
    if (result.resolution.toLowerCase() === "3k")
      throw new BadRequestException("清晰度档位 3k 已下线，请改用 1k/2k/4k")
    result.resolution = result.resolution.toLowerCase()
  }
  let ratio: number | undefined
  if (result.aspect_ratio !== undefined) {
    if (
      typeof result.aspect_ratio !== "string" ||
      !/^[1-9]\d*:[1-9]\d*$/.test(result.aspect_ratio)
    )
      throw new BadRequestException("图片比例格式应为正整数宽:高")
    const [w, h] = result.aspect_ratio.split(":").map(Number)
    ratio = w / h
  }
  if (result.size !== undefined) {
    if (typeof result.size !== "string" || !/^\d+[x×*]\d+$/i.test(result.size))
      throw new BadRequestException("像素尺寸格式应为宽x高")
    const [w, h] = result.size.split(/[x×*]/i).map(Number)
    if (![w, h].every(value => Number.isSafeInteger(value) && value > 0))
      throw new BadRequestException("像素宽高必须为正整数")
    result.size = `${w}x${h}`
    if (ratio !== undefined && Math.abs(w - h * ratio) > Math.max(1, ratio))
      throw new BadRequestException("size 与 aspect_ratio 的图片比例冲突")
    if (
      result.resolution !== undefined &&
      Math.abs(Math.max(w, h) - Number(String(result.resolution)[0]) * 1024) > 1
    )
      throw new BadRequestException("size 与 resolution 的清晰度档位冲突")
  }
  return result
}

/** 网关 resolution 档位值：3K 已下线（2026-09-14 全目录枚举仅 1k/2k/4k），
 *  存量 DB 快照重放/老前端入口的 3K 在此降档 2k，其余小写直传。 */
export function gatewayResolutionValue(tier: string): string {
  return tier.trim().toUpperCase() === "3K" ? "2k" : tier.trim().toLowerCase()
}

/** 档位 → 目标长边像素，与通用生图 core/size-adapters 的 TIER_LONG_SIDE 同口径
 * （3K 保留映射服务存量快照；发往网关前由 gatewayResolutionValue 统一降档）。 */
export const GATEWAY_TIER_LONG_SIDE: Record<string, number> = {
  "1K": 1024,
  "2K": 2048,
  "3K": 3072,
  "4K": 4096,
}

export interface GatewaySizingIntentInput {
  /** 任意比例串（"16:9" / "11:10" / "463:45"…），允许十档枚举原样传入。 */
  aspectRatio: string
  /** 清晰度档位（大小写不敏感；3K 转 2k），缺省按 1K。 */
  resolutionTier?: string
  /** 兼容调用方快照；所有模型共用网关尺寸意图。 */
  modelId?: string
}

export interface GatewaySizingIntent {
  size?: string
  aspect_ratio?: string
  resolution?: string
}

/** 统一输出比例和清晰度；省略清晰度的历史请求按 1K 兼容。 */
export function resolveGatewaySizingIntent(input: GatewaySizingIntentInput): GatewaySizingIntent {
  return resolveGatewaySizingIntentDetailed(input).sizing
}

export interface GatewaySizingPlanResult {
  sizing: GatewaySizingIntent
  /** 尺寸能力降档/改写说明链（观测与前端 warnings 透出）；空 = 未调整 */
  adjustments: string[]
}

/** 所有模型统一提交用户的比例和档位，尺寸能力适配由网关负责。 */
export function resolveGatewaySizingIntentDetailed(
  input: GatewaySizingIntentInput
): GatewaySizingPlanResult {
  return { sizing: resolveBaseSizingIntent(input), adjustments: [] }
}

function resolveBaseSizingIntent(input: GatewaySizingIntentInput): GatewaySizingIntent {
  const raw = input.aspectRatio.trim()
  const parts = raw.split(":").map(Number)
  if (parts.length !== 2 || !parts.every(value => Number.isSafeInteger(value) && value > 0))
    throw new BadRequestException("图片比例格式应为正整数宽:高")
  const resolution = gatewayResolutionValue(input.resolutionTier ?? "1K")
  if (!["1k", "2k", "4k"].includes(resolution))
    throw new BadRequestException("清晰度档位仅支持 1K/2K/4K")
  return { aspect_ratio: raw, resolution }
}

/** 历史像素参数在提交边界兼容转换，网关只接收比例和档位。 */
export function gatewayImageRequestSizing(params: Record<string, unknown>) {
  const legacy = { ...params }
  if (typeof legacy.resolution === "string" && legacy.resolution.toLowerCase() === "3k") legacy.resolution = "2k"
  if (typeof legacy.size === "string" && legacy.size.toLowerCase() === "3k") legacy.size = "2k"
  const normalized = normalizeGatewayImageSizing(legacy)
  let aspectRatio = normalized.aspect_ratio as string | undefined
  let tier = normalized.resolution as string | undefined
  if (aspectRatio === undefined && typeof params.width === "number" && typeof params.height === "number") {
    aspectRatio = `${params.width}:${params.height}`
    const edge = Math.max(params.width, params.height)
    tier ??= edge <= 1024 ? "1K" : edge <= 2048 ? "2K" : "4K"
  }
  const pixelSize = typeof normalized.size === "string" ? normalized.size.match(/^(\d+)x(\d+)$/) : null
  if (pixelSize) {
    const width = Number(pixelSize[1]), height = Number(pixelSize[2])
    aspectRatio ??= `${width}:${height}`
    const edge = Math.max(width, height)
    tier ??= ["1K", "2K", "3K", "4K"].reduce((best, candidate) =>
      Math.abs(GATEWAY_TIER_LONG_SIDE[candidate] - edge) <= Math.abs(GATEWAY_TIER_LONG_SIDE[best] - edge)
        ? candidate : best)
  }
  const result = { ...normalized }
  for (const key of ["size", "width", "height", "resolution_tier"]) delete result[key]
  return { ...result, ...resolveGatewaySizingIntent({ aspectRatio: aspectRatio ?? "1:1", resolutionTier: tier }), strict: false }
}
