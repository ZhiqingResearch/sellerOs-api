import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Decimal } from "@prisma/client/runtime/library"
import {
  AiGatewayClient,
  GatewayApiError,
  GatewayConnectionError,
  GatewayRequestValidationError,
  GatewayTimeoutError,
  type ChatCompletion,
  type ChatCompletionRequest,
  type GatewayModel,
  type ImageTask,
  type ImageTaskRequest,
  type JsonRequestOptions,
  type ModelRequestSchema,
  type ModelSummary,
  type PricingEstimate,
  type PricingEstimateVariant,
  type TaskUsage,
  type UsageRecord,
  type VideoGenerationRequest,
  type VideoModelDetail,
  type VideoTask,
} from "@zhiqingresearch/ai-ts-sdk"
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici"

import { gatewayImageRequestSizing } from "./gateway-image-sizing"

const DEFAULT_AI_GATEWAY_TIMEOUT_MS = 300_000

export interface MultimodalCompletionResult {
  completion: ChatCompletion
  requestId: string
}

/** 网关 API Key 归属：platform 本平台任务 / vidflowos VidFlowOS 代办任务（按调用方分账） */
export type GatewayKeyOwner = "platform" | "vidflowos"

@Injectable()
export class AiGatewayProvider {
  private readonly logger = new Logger(AiGatewayProvider.name)
  private readonly gateway: AiGatewayClient | null
  /** VidFlowOS 专属 Key 客户端（可选；未配置 AI_GATEWAY_VIDFLOWOS_API_KEY 时为 null） */
  private readonly vidflowosGateway: AiGatewayClient | null
  private readonly waitingGateway: AiGatewayClient | null

  constructor(config: ConfigService) {
    const apiKey = config.get<string>("AI_GATEWAY_API_KEY")?.trim() ?? ""
    const baseURL = config.get<string>("AI_GATEWAY_BASE_URL")?.trim() ?? ""
    if (!apiKey || !baseURL) {
      this.gateway = null
      this.vidflowosGateway = null
      this.waitingGateway = null
      return
    }

    this.gateway = new AiGatewayClient({
      baseURL,
      apiKey,
      timeoutMs: DEFAULT_AI_GATEWAY_TIMEOUT_MS,
      getRetry: { maxRetries: 0 },
    })

    // VidFlowOS 代办任务用独立 Key 调同一网关（网关侧按 Key 分账/隔离）；
    // 未配置则 vidflowos 通道不可用（内部生成接口提交时报 503）。
    const vidflowosApiKey = config.get<string>("AI_GATEWAY_VIDFLOWOS_API_KEY")?.trim() ?? ""
    this.vidflowosGateway = vidflowosApiKey
      ? new AiGatewayClient({
          baseURL,
          apiKey: vidflowosApiKey,
          timeoutMs: DEFAULT_AI_GATEWAY_TIMEOUT_MS,
          getRetry: { maxRetries: 0 },
        })
      : null
    const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
    this.waitingGateway = new AiGatewayClient({
      baseURL,
      apiKey,
      timeoutMs: DEFAULT_AI_GATEWAY_TIMEOUT_MS,
      getRetry: { maxRetries: 0 },
      // SDK 在收到响应头后清除计时器；独立 signal 覆盖接收正文的总等待时间。
      fetch: (input, init) =>
        undiciFetch(
          input as string,
          {
            ...init,
            signal: AbortSignal.any([
              ...(init?.signal ? [init.signal] : []),
              AbortSignal.timeout(DEFAULT_AI_GATEWAY_TIMEOUT_MS),
            ]),
            dispatcher,
          } as UndiciRequestInit
        ) as unknown as Promise<Response>,
    })
  }

  isConfigured(): boolean {
    return this.gateway !== null
  }

  /** vidflowos 通道是否可用（未配置专属 Key 时内部生成接口应拒绝代办提交） */
  isVidflowosConfigured(): boolean {
    return this.vidflowosGateway !== null
  }

  async createImageTask(
    params: ImageTaskRequest,
    idempotencyKey: string,
    keyOwner: GatewayKeyOwner = "platform"
  ): Promise<ImageTask> {
    const gateway = this.getGateway(keyOwner)
    if (!idempotencyKey.trim()) {
      throw new BadRequestException("AI Gateway 图片任务缺少幂等键")
    }

    try {
      const request = gatewayImageRequestSizing(params as unknown as Record<string, unknown>) as unknown as ImageTaskRequest
      const response = await gateway.images.withResponse.createTask(request, { idempotencyKey })
      this.logger.log(
        `[AI Gateway] 图片任务已提交 model=${params.model} task=${response.data.id}${this.requestIdSuffix(response.response.requestId)}`
      )
      this.validateImageTask(response.data)
      return response.data
    } catch (error: unknown) {
      throw this.toGatewayException("提交图片任务", error)
    }
  }

  async completeMultimodal(
    request: ChatCompletionRequest,
    options?: JsonRequestOptions,
    waitForCompletion = false
  ): Promise<MultimodalCompletionResult> {
    try {
      const gateway = waitForCompletion
        ? (this.waitingGateway ?? this.getGateway())
        : this.getGateway()
      const response = await gateway.chat.withResponse.complete(request, options)
      const requestId = response.response.requestId?.trim()
      if (!requestId) {
        throw new BadGatewayException("AI Gateway 多模态调用缺少 requestId，无法结算")
      }
      this.logger.log(
        `[AI Gateway] 多模态调用完成 model=${request.model}${this.requestIdSuffix(requestId)}`
      )
      return { completion: response.data, requestId }
    } catch (error: unknown) {
      throw this.toGatewayException("调用多模态模型", error)
    }
  }

  async getUsageByRequestId(requestId: string): Promise<UsageRecord | null> {
    const normalized = requestId.trim()
    if (!normalized) throw new BadRequestException("AI Gateway 用量查询缺少 requestId")

    try {
      const page = await this.getGateway().usage.list({ requestId: normalized, take: 10 })
      const usage = page.data.find(item => item.request_id === normalized) ?? null
      if (!usage) return null
      if (usage.currency !== "CNY") {
        throw new BadGatewayException(`AI Gateway 返回了不支持的用量币种：${usage.currency}`)
      }
      if (usage.amount !== null) {
        const amount = new Decimal(usage.amount)
        // "-0" 数值上为零：放行走零金额跳过，不算无效金额
        if (!amount.isFinite() || (amount.isNegative() && !amount.isZero())) {
          throw new BadGatewayException("AI Gateway 返回了无效的用量金额")
        }
      }
      return usage
    } catch (error: unknown) {
      throw this.toGatewayException("查询多模态用量", error)
    }
  }

  /** 轨道 B:IMAGE 模型目录(生图下拉聚合端点用;照 listVideoModels 模式)。 */
  async listImageModels(): Promise<ModelSummary[]> {
    try {
      const params = { modality: "IMAGE" as const }
      this.logPayload("请求", "查询图片模型目录", params)
      const response = await this.getGateway().models.withResponse.list(params)
      this.logPayload("响应", "查询图片模型目录", response.data)
      this.logger.log(
        `[AI Gateway] 图片模型目录已获取 count=${response.data.data.length}${this.requestIdSuffix(response.response.requestId)}`
      )
      return response.data.data
    } catch (error: unknown) {
      throw this.toGatewayException("查询图片模型目录", error)
    }
  }

  async listVideoModels(): Promise<ModelSummary[]> {
    try {
      const params = { modality: "VIDEO" as const }
      this.logPayload("请求", "查询视频模型目录", params)
      const response = await this.getGateway().models.withResponse.list(params)
      this.logPayload("响应", "查询视频模型目录", response.data)
      this.logger.log(
        `[AI Gateway] 视频模型目录已获取 count=${response.data.data.length}${this.requestIdSuffix(response.response.requestId)}`
      )
      return response.data.data
    } catch (error: unknown) {
      throw this.toGatewayException("查询视频模型目录", error)
    }
  }

  async getVideoModel(publicId: string): Promise<VideoModelDetail> {
    try {
      this.logPayload("请求", "查询视频模型详情", { publicId })
      const model = await this.getGateway().models.get(publicId)
      this.logPayload("响应", "查询视频模型详情", model)
      if (model.modality !== "video") {
        throw new BadRequestException(`AI Gateway 模型不是视频模型：${publicId}`)
      }
      return model
    } catch (error: unknown) {
      throw this.toGatewayException("查询视频模型详情", error)
    }
  }

  async getVideoRequestSchema(publicId: string): Promise<ModelRequestSchema> {
    try {
      const params = {
        operation: "videos.generations",
      } as const
      this.logPayload("请求", "查询视频模型请求 Schema", { publicId, ...params })
      const schema = await this.getGateway().models.requestSchema(publicId, params)
      this.logPayload("响应", "查询视频模型请求 Schema", schema)
      return schema
    } catch (error: unknown) {
      throw this.toGatewayException("查询视频模型请求 Schema", error)
    }
  }

  /**
   * 目录同步专用：一次取模型详情 + 请求 Schema（operation 按模态传入：视频 videos.generations / 图片 images.generations）。
   * 网关 404（模型已下架）返回 null 供调用方置 gatewayActive=false，其余错误统一包装抛出。
   * detail 为三模态联合，是否目标模态由调用方按 modality 判断。
   */
  async fetchModelSnapshot(
    publicId: string,
    operation: "videos.generations" | "images.generations"
  ): Promise<{ detail: GatewayModel; requestSchema: ModelRequestSchema } | null> {
    const gateway = this.getGateway()
    try {
      const [detail, requestSchema] = await Promise.all([
        gateway.models.get(publicId),
        gateway.models.requestSchema(publicId, { operation }),
      ])
      return { detail, requestSchema }
    } catch (error: unknown) {
      if (error instanceof GatewayApiError && error.status === 404) return null
      throw this.toGatewayException("同步模型目录", error)
    }
  }

  async estimateVideoPrice(
    params: VideoGenerationRequest
  ): Promise<PricingEstimate<"videos.generations">> {
    try {
      const request = {
        operation: "videos.generations",
        request: params,
        expand: ["resolution"] as const,
      } as const
      this.logPayload("请求", "预估视频价格", request)
      const response = await this.getGateway().pricing.withResponse.estimate(request)
      this.logPayload("响应", "预估视频价格", response.data)
      this.logger.log(
        `[AI Gateway] 视频价格预估完成 model=${params.model} variants=${response.data.variants.length}${this.requestIdSuffix(response.response.requestId)}`
      )
      if (response.data.currency !== "CNY") {
        throw new BadGatewayException(
          `AI Gateway 返回了不支持的报价币种：${response.data.currency}`
        )
      }
      return response.data
    } catch (error: unknown) {
      throw this.toGatewayException("预估视频价格", error)
    }
  }

  maximumQuoteAmount(variants: PricingEstimateVariant[]): Decimal {
    if (!variants.length) throw new BadGatewayException("AI Gateway 未返回价格预估")
    return variants.reduce((maximum, variant) => {
      const amount = variant.maximum_amount ?? variant.estimated_amount ?? variant.minimum_amount
      if (amount == null) throw new BadGatewayException("AI Gateway 返回了不完整的价格预估")

      let value: Decimal
      try {
        value = new Decimal(amount)
      } catch {
        throw new BadGatewayException("AI Gateway 返回了无效的价格预估")
      }
      if (!value.isFinite() || value.isNegative()) {
        throw new BadGatewayException("AI Gateway 返回了无效的价格预估")
      }
      return Decimal.max(maximum, value)
    }, new Decimal(0))
  }

  async createVideoTask(
    params: VideoGenerationRequest,
    idempotencyKey: string,
    keyOwner: GatewayKeyOwner = "platform"
  ): Promise<VideoTask> {
    const gateway = this.getGateway(keyOwner)
    if (!idempotencyKey.trim()) {
      throw new BadRequestException("AI Gateway 视频任务缺少幂等键")
    }

    try {
      this.logPayload("请求", "提交视频任务", { params, idempotencyKey })
      const response = await gateway.videos.withResponse.generate(params, { idempotencyKey })
      this.logPayload("响应", "提交视频任务", response.data)
      this.logger.log(
        `[AI Gateway] 视频任务已提交 model=${params.model} task=${response.data.id}${this.requestIdSuffix(response.response.requestId)}`
      )
      this.validateVideoTask(response.data)
      return response.data
    } catch (error: unknown) {
      throw this.toGatewayException("提交视频任务", error)
    }
  }

  async getTask(taskId: string, keyOwner: GatewayKeyOwner = "platform"): Promise<VideoTask> {
    try {
      this.logPayload("请求", "查询视频任务", { taskId, keyOwner })
      const task = await this.getGateway(keyOwner).tasks.get<VideoTask>(taskId)
      this.logPayload("响应", "查询视频任务", task)
      this.validateVideoTask(task)
      return task
    } catch (error: unknown) {
      throw this.toGatewayException("查询任务", error)
    }
  }

  async getImageTask(taskId: string, keyOwner: GatewayKeyOwner = "platform"): Promise<ImageTask> {
    try {
      const task = await this.getGateway(keyOwner).tasks.get<ImageTask>(taskId)
      this.validateImageTask(task)
      return task
    } catch (error: unknown) {
      throw this.toGatewayException("查询图片任务", error)
    }
  }

  async cancelVideoTask(
    taskId: string,
    keyOwner: GatewayKeyOwner = "platform"
  ): Promise<VideoTask> {
    try {
      this.logPayload("请求", "取消视频任务", { taskId, keyOwner })
      const task = await this.getGateway(keyOwner).tasks.cancel<VideoTask>(taskId)
      this.logPayload("响应", "取消视频任务", task)
      this.validateVideoTask(task)
      return task
    } catch (error: unknown) {
      throw this.toGatewayException("取消视频任务", error)
    }
  }

  private getGateway(keyOwner: GatewayKeyOwner = "platform"): AiGatewayClient {
    if (keyOwner === "vidflowos") {
      if (!this.vidflowosGateway) {
        throw new ServiceUnavailableException(
          "未配置 AI_GATEWAY_VIDFLOWOS_API_KEY（vidflowos 通道不可用）"
        )
      }
      return this.vidflowosGateway
    }
    if (!this.gateway) {
      throw new ServiceUnavailableException("未配置 AI_GATEWAY_API_KEY 或 AI_GATEWAY_BASE_URL")
    }
    return this.gateway
  }

  validateVideoTask(task: VideoTask): TaskUsage | null {
    switch (task.status) {
      case "queued":
      case "running":
        return null
      case "failed":
      case "canceled":
      case "expired":
        return task.usage ? this.validateUsage(task.usage) : null
    }

    if (task.result.videos.length === 0) {
      throw new BadGatewayException("AI Gateway 视频任务成功但未返回视频")
    }
    for (const video of task.result.videos) {
      try {
        if (new URL(video.url).protocol !== "https:") throw new Error()
      } catch {
        throw new BadGatewayException("AI Gateway 视频任务返回了无效的视频链接")
      }
    }
    return this.validateUsage(task.usage)
  }

  validateImageTask(task: ImageTask): TaskUsage | null {
    if (task.status === "queued" || task.status === "running") return null

    const artifacts =
      task.status === "succeeded"
        ? "images" in task.result
          ? task.result.images
          : task.result.layer_stack.outputs
        : "error" in task
          ? (task.partial_result?.images ?? [])
          : []

    if (task.status === "succeeded" && artifacts.length === 0) {
      throw new BadGatewayException("AI Gateway 图片任务成功但未返回图片")
    }
    for (const artifact of artifacts) {
      try {
        if (new URL(artifact.url).protocol !== "https:") throw new Error()
      } catch {
        throw new BadGatewayException("AI Gateway 图片任务返回了无效的图片链接")
      }
    }
    const usage = "usage" in task ? task.usage : undefined
    return usage ? this.validateUsage(usage) : null
  }

  private validateUsage(usage: TaskUsage | undefined): TaskUsage {
    if (!usage) {
      throw new BadGatewayException("AI Gateway 任务缺少计费信息")
    }
    if (usage.currency !== "CNY") {
      throw new BadGatewayException(`AI Gateway 任务返回了不支持的币种：${usage.currency}`)
    }

    try {
      const amount = new Decimal(usage.amount)
      // "-0" 数值上为零：放行走零金额跳过，不算无效金额
      if (!amount.isFinite() || (amount.isNegative() && !amount.isZero())) throw new Error()
    } catch {
      throw new BadGatewayException("AI Gateway 任务返回了无效的计费金额")
    }
    return usage
  }

  private toGatewayException(action: string, error: unknown): HttpException {
    if (error instanceof HttpException) return error
    if (error instanceof GatewayApiError) {
      const suffix = this.requestIdSuffix(error.requestId)
      this.logger.error(
        `[AI Gateway] ${action}失败 status=${error.status} type=${error.type ?? "unknown"} code=${error.code ?? "unknown"} retryAfterMs=${error.retryAfterMs ?? "none"}${suffix}: ${error.message}`
      )
      const message = `AI Gateway ${action}失败：${error.message}${suffix}`
      if (error.status === 400 || error.status === 404) return new BadRequestException(message)
      if (error.status === 401 || error.status === 403) {
        return new ServiceUnavailableException("AI Gateway 配置或模型授权异常")
      }
      if (error.status === 408 || error.status === 504) {
        return new GatewayTimeoutException(`AI Gateway ${action}超时${suffix}`)
      }
      if (error.status === 429) {
        return new HttpException(`AI Gateway 请求过于频繁${suffix}`, HttpStatus.TOO_MANY_REQUESTS)
      }
      return new BadGatewayException(message)
    }
    if (error instanceof GatewayRequestValidationError) {
      const detail = error.issues
        .map(issue => issue.message)
        .filter(Boolean)
        .join("；")
      const message = detail || error.message
      this.logger.error(`[AI Gateway] ${action}参数校验失败: ${message}`)
      return new BadRequestException(`AI Gateway ${action}失败：${message}`)
    }
    if (
      error instanceof GatewayTimeoutError ||
      (error instanceof Error &&
        (error.cause as { name?: string } | undefined)?.name === "TimeoutError")
    ) {
      this.logger.error(`[AI Gateway] ${action}超时: ${error.message}`)
      return new GatewayTimeoutException(`AI Gateway ${action}超时`)
    }
    if (error instanceof GatewayConnectionError) {
      this.logger.error(`[AI Gateway] ${action}连接失败: ${error.message}`)
      return new BadGatewayException(`AI Gateway ${action}失败：服务暂时不可用`)
    }
    const message = error instanceof Error ? error.message : String(error)
    this.logger.error(`[AI Gateway] ${action}失败: ${message}`)
    return new BadGatewayException(`AI Gateway ${action}失败：服务异常`)
  }

  private requestIdSuffix(requestId: string | null): string {
    return requestId ? ` [requestId=${requestId}]` : ""
  }

  private logPayload(direction: "请求" | "响应", action: string, payload: unknown): void {
    this.logger.log(`[AI Gateway][${direction}] ${action} payload=${JSON.stringify(payload)}`)
  }
}
