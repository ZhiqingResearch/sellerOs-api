import { BadRequestException, ServiceUnavailableException } from "@nestjs/common"
import type { ImageTaskRequest } from "@zhiqingresearch/ai-ts-sdk"
import type { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import {
  resolveGatewaySizingIntentDetailed,
  type GatewaySizingIntent,
} from "../ai-gateway/gateway-image-sizing"
import { resolveGatewayImageSizing } from "../ai-gateway/gateway-native-image-sizing"

export const PORTRAIT_RESOLUTION_TIERS = ["1K", "2K", "3K", "4K"] as const
export type PortraitResolutionTier = (typeof PORTRAIT_RESOLUTION_TIERS)[number]

export interface PortraitDeliveryTarget {
  aspectRatio?: string | null
  resolutionTier?: PortraitResolutionTier | null
  /** @deprecated 已统一为 ratio 模式；保留仅为识别并明确拒绝旧请求 */
  customSizeMode?: "ratio" | "pixels" | null
  /** @deprecated 同上 */
  customWidth?: number | null
  /** @deprecated 同上 */
  customHeight?: number | null
}

export interface NormalizedPortraitDeliveryTarget {
  aspectRatio: string
  resolutionTier: PortraitResolutionTier
  width: number
  height: number
}

export interface PortraitProviderApplied {
  aspectRatio?: string | null
  resolutionTier?: string | null
  size?: string | null
  width?: number | null
  height?: number | null
}

export interface PortraitDeliveryPlan {
  /** 新任务的提示词与裁剪锚点同步；旧快照缺省保留既有裁剪策略。 */
  cropAnchor?: "centre"
  /** 兼容历史快照；当前交付始终检查实际出图比例。 */
  nativeSizing?: boolean
  requested: NormalizedPortraitDeliveryTarget
  providerApplied: PortraitProviderApplied
  delivery: {
    width: number
    height: number
    strategy: string
    nativeResolution: boolean | null
  }
  warnings: string[]
}

export interface PortraitSizePlanResult {
  providerModelParams: Record<string, unknown>
  deliveryPlan: PortraitDeliveryPlan
}

const TIER_LONG_SIDE: Record<PortraitResolutionTier, number> = {
  "1K": 1024,
  "2K": 2048,
  "3K": 3072,
  "4K": 4096,
}

/** model_params 携带的原始尺寸键：走网关 intent 通道前统一剥离，由
 * planPortraitSizing 注入解析后的 sizing 参数（人像 / AI 拆图共用）。 */
export const PORTRAIT_DIMENSION_PARAM_KEYS = new Set([
  "aspect_ratio",
  "size",
  "width",
  "height",
  "resolution",
  "resolution_tier",
])

/** 像素长边 → 就近清晰度档位；平手时向上取高档位（旧像素参数归一用） */
export function tierFromLongestSide(longest: number): PortraitResolutionTier {
  let best: PortraitResolutionTier = "1K"
  let bestDiff = Number.POSITIVE_INFINITY
  for (const tier of Object.keys(TIER_LONG_SIDE) as PortraitResolutionTier[]) {
    const diff = Math.abs(TIER_LONG_SIDE[tier] - longest)
    if (diff <= bestDiff) {
      best = tier
      bestDiff = diff
    }
  }
  return best
}

/** 旧像素目标归一：保留宽高原值作为比例，兼容推导档位（统一 ratio 模式） */
export function ratioTierFromDimensions(
  width: number,
  height: number
): { aspectRatio: string; resolutionTier: PortraitResolutionTier } {
  return {
    aspectRatio: `${width}:${height}`,
    resolutionTier: tierFromLongestSide(Math.max(width, height)),
  }
}

function parseRatio(raw: string): { numerator: number; denominator: number; value: number } {
  const match = raw.trim().match(/^(\d+):(\d+)$/)
  if (!match) throw new BadRequestException("图片比例格式应为宽:高")
  const numerator = Number(match[1])
  const denominator = Number(match[2])
  if (!numerator || !denominator) throw new BadRequestException("图片比例不能为 0")
  if (![numerator, denominator].every(Number.isSafeInteger))
    throw new BadRequestException("图片比例宽高必须为正安全整数")
  return { numerator, denominator, value: numerator / denominator }
}

/** 交付目标归一（原 PortraitSizePlanner.normalizeTarget）：统一 ratio 模式，
 * 比例原值保留，档位仅用于交付元信息的预期像素。 */
export function normalizePortraitDeliveryTarget(
  target: PortraitDeliveryTarget
): NormalizedPortraitDeliveryTarget {
  // 统一 ratio 模式：不再支持指定像素输出，旧像素字段传入即明确报错
  if (
    target.customSizeMode === "pixels" ||
    target.customWidth != null ||
    target.customHeight != null
  ) {
    throw new BadRequestException(
      "不再支持指定像素输出，请使用 aspectRatio + resolutionTier（比例 + 清晰度档位）"
    )
  }

  const aspectRatio = target.aspectRatio?.trim()
  if (!aspectRatio) throw new BadRequestException("比例模式必须填写图片比例")
  const ratio = parseRatio(aspectRatio)
  const tier = target.resolutionTier
  if (!tier) throw new BadRequestException("比例模式必须填写清晰度档位")
  const longSide = TIER_LONG_SIDE[tier]
  const [width, height] =
    ratio.value >= 1
      ? [longSide, Math.round(longSide / ratio.value)]
      : [Math.round(longSide * ratio.value), longSide]
  return {
    aspectRatio,
    resolutionTier: tier,
    width,
    height,
  }
}

/** 人像与拆图统一冻结比例/清晰度，回调交付时按实测比例中心裁剪。 */
export function planPortraitSizing(input: {
  target: PortraitDeliveryTarget
  modelParams: Record<string, unknown>
  /** 兼容旧调用方的模型标识。 */
  modelId?: string
  gatewaySizing?: GatewaySizingIntent
}): PortraitSizePlanResult {
  const requested = normalizePortraitDeliveryTarget(input.target)
  if (input.gatewaySizing?.aspect_ratio) requested.aspectRatio = input.gatewaySizing.aspect_ratio
  const warnings: string[] = []
  if (requested.resolutionTier === "3K") {
    warnings.push("清晰度档位 3K 已下线，已按 2K 档生成")
  }
  const { sizing: intent, adjustments } = input.gatewaySizing
    ? { sizing: input.gatewaySizing, adjustments: [] }
    : resolveGatewaySizingIntentDetailed({
        aspectRatio: requested.aspectRatio,
        resolutionTier: requested.resolutionTier,
        modelId: input.modelId,
      })
  warnings.push(...adjustments)

  const providerModelParams: Record<string, unknown> = { ...input.modelParams }
  for (const key of Object.keys(providerModelParams)) {
    if (PORTRAIT_DIMENSION_PARAM_KEYS.has(key)) delete providerModelParams[key]
  }
  Object.assign(providerModelParams, intent)

  return {
    providerModelParams,
    deliveryPlan: {
      cropAnchor: "centre",
      requested,
      providerApplied: {
        aspectRatio: intent.aspect_ratio ?? null,
        resolutionTier: intent.resolution ?? null,
        size: intent.size ?? null,
        width: null,
        height: null,
      },
      delivery: {
        width: requested.width,
        height: requested.height,
        strategy: "crop_to_ratio",
        nativeResolution: null,
      },
      warnings,
    },
  }
}

/** 查询最新参数配置校验完整请求；历史像素输入兼容转换为比例和档位。 */
export async function planPortraitSizingWithGateway(
  input: Parameters<typeof planPortraitSizing>[0] & { request: ImageTaskRequest; modelId: string },
  gateway: AiGatewayProvider
): Promise<
  PortraitSizePlanResult & {
    gatewayConfig?: NonNullable<Awaited<ReturnType<AiGatewayProvider["fetchModelSnapshot"]>>>
  }
> {
  normalizePortraitDeliveryTarget(input.target)
  const pixelParams =
    input.modelParams.width !== undefined ||
    input.modelParams.height !== undefined ||
    [input.modelParams.size, input.modelParams.resolution].some(value =>
      typeof value === "string" && /^\d{2,5}\s*[x×*]\s*\d{2,5}$/i.test(value.trim())
    )
  if (pixelParams) return planPortraitSizing(input)
  const snapshot = await gateway.fetchModelSnapshot(input.modelId, "images.generations")
  if (!snapshot || snapshot.detail.modality !== "image") {
    throw new ServiceUnavailableException("生图模型未就绪，请稍后重试")
  }
  const request = { ...input.request } as unknown as Record<string, unknown>
  for (const key of PORTRAIT_DIMENSION_PARAM_KEYS) delete request[key]
  const facts = snapshot.detail.facts as Record<string, unknown> | undefined
  const formats = Array.isArray(facts?.output_formats)
    ? facts.output_formats.filter((value): value is string => typeof value === "string")
    : []
  if (request.output_format === undefined && formats.length)
    request.output_format = formats.includes("png") ? "png" : formats[0]
  let gatewaySizing: ReturnType<typeof resolveGatewayImageSizing>
  try {
    gatewaySizing = resolveGatewayImageSizing(
      snapshot,
      input.target.aspectRatio!.trim(),
      input.target.resolutionTier!,
      request
    )
  } catch (error) {
    if (error instanceof BadRequestException) throw error
    throw new ServiceUnavailableException("生图模型参数配置无效，请联系管理员同步模型")
  }
  if (!gatewaySizing) throw new ServiceUnavailableException("生图参数与模型配置不兼容，请联系管理员同步模型")
  return {
    ...planPortraitSizing({
      ...input,
      modelParams: {
        ...input.modelParams,
        ...gatewaySizing,
        ...(request.output_format !== undefined ? { output_format: request.output_format } : {}),
      },
      gatewaySizing,
    }),
    gatewayConfig: snapshot,
  }
}
