import type { ImageGenerationCount, ImageTaskRequest } from "@zhiqingresearch/ai-ts-sdk"
import { normalizeGatewayImageSizing } from "../ai-gateway/gateway-image-sizing"

export const PORTRAIT_IMAGE_GENERATOR = Symbol("PORTRAIT_IMAGE_GENERATOR")

export const PORTRAIT_PROTECTED_MODEL_PARAM_KEYS = new Set([
  "model",
  "prompt",
  "callback",
  "callback_data",
  "operation",
  "n",
  "reference_images",
  "reference_videos",
  "response_format",
])

export interface PortraitReferenceImage {
  url: string
  purpose: string
}

export interface PortraitImageGenerateInput {
  /** 原生能力已校验，提交时保留网关枚举原值。 */
  nativeSizing?: boolean
  taskId: number
  prompt: string
  model: string
  quantity: number
  referenceImages: PortraitReferenceImage[]
  modelParams: Record<string, unknown>
  /** 基于本地 GenerationTask ID 生成的稳定幂等键，防止重复提交和重复计费。 */
  idempotencyKey: string
}

export interface PortraitImageGenerateResult {
  jobId: string
}

/**
 * 人像业务与具体模型供应商之间的唯一边界。
 * 后续接模型时实现本接口并替换模块中的 provider 绑定即可。
 */
export interface PortraitImageGenerator {
  isAvailable(): boolean
  submit(input: PortraitImageGenerateInput): Promise<PortraitImageGenerateResult>
}

/**
 * 动态模型参数先展开，固定业务参数后覆盖。
 * 即使历史脏数据绕过创建时校验，也不能覆盖模型、提示词、回调和参考图等受控字段。
 */
export function buildPortraitImageTaskRequest(
  input: Omit<PortraitImageGenerateInput, "taskId" | "idempotencyKey">
): ImageTaskRequest {
  const request: Record<string, unknown> = {
    ...(input.nativeSizing ? input.modelParams : normalizeGatewayImageSizing(input.modelParams)),
    model: input.model,
    prompt: input.prompt,
    operation: input.referenceImages.length > 0 ? "edit" : "generate",
    n: input.quantity as ImageGenerationCount,
    callback: true,
  }
  if (input.referenceImages.length > 0) {
    request.reference_images = input.referenceImages.map(reference => ({ url: reference.url }))
  } else {
    delete request.reference_images
  }
  return request as unknown as ImageTaskRequest
}
