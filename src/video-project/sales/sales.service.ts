import { modelDisplayNames, videoMetadata } from "../../common/utils/generation-metadata"
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { AiModelExecMode, AiModelModality, Prisma } from "@prisma/client"
import type { VideoAspectRatio } from "@zhiqingresearch/ai-ts-sdk"
import { PrismaService } from "../../prisma/prisma.service"
import { AiGatewayWebhookService } from "../../ai-gateway/ai-gateway-webhook.service"
import { VideoProjectService } from "../video-project.service"
import {
  CreateSalesProjectDto,
  GenerateSalesDto,
  SaveSalesMaterialsDto,
  SaveSalesProductDto,
  SaveSalesScriptDto,
} from "./sales.dto"

type Json = Prisma.InputJsonValue

// 生成视频片段时，已成功/运行中的分镜跳过；仅这些终态可重新生成
const REGENERATABLE_STATUSES = new Set(["FAILED", "TIMEOUT", "CANCELLED"])

// 读取出片任务时附带的字段（成片预览 / 重生成判定 / 历史排序 / 按 segmentOrder 归组）。
// prompt + 参数随任务一并下发：历史版本能还原各自当时用的提示词与出片参数。
const SEGMENT_TASK_SELECT = {
  id: true,
  status: true,
  gatewayTaskId: true, // 读时对账需要：GENERATING 行据此查网关真实状态
  prompt: true, // 本条出片实际使用的提示词（分段=该分镜 vidPrompt，一键=拼接稿）
  resultUrl: true,
  thumbnailUrl: true,
  model: true,
  mode: true,
  generationParams: true,
  deliveryMeta: true,
  modelName: true,
  durationSec: true,
  aspectRatio: true,
  resolution: true,
  errorMessage: true,
  gatewayError: true, // 网关终态失败原始错误 { code, type, message, requestId }，排查用
  segmentOrder: true,
  salesBatchNo: true,
  createdAt: true,
} satisfies Prisma.VideoTaskSelect

type SalesVideoTask = Prisma.VideoTaskGetPayload<{ select: typeof SEGMENT_TASK_SELECT }>

// 旧数据无批次号：归并到批次 0（作为最早一份历史版本）
const batchOf = (task: SalesVideoTask) => task.salesBatchNo ?? 0

// 成片版本里的单条视频：一段（分段生成）或整片（一键成片）
type SalesOutputVideo = {
  segmentOrder: number | null
  startSec: number
  endSec: number
  taskId: number
  status: string
  prompt: string | null
  resultUrl: string | null
  thumbnailUrl: string | null
  publicId: string
  mode: string
  displayName: string
  durationSec: number | null
  aspectRatio: string | null
  resolution: string | null
  errorMessage: string | null
  gatewayError: Json | null
  createdAt: Date
}

// 一份连贯成片版本（同一次 generate 的产出）：
//   一键成片 → videos 仅 1 条（整片）；分段生成 → videos 为各分镜，按 segmentOrder 顺序播放。
//   outputs[0] 永远是最新版本，videos[0] 是该版本的第一段。
type SalesOutputVersion = {
  batchNo: number
  createdAt: Date
  videos: SalesOutputVideo[]
}

// 出片复用入参（一键成片 / 分段生成共享，差异仅 prompt + durationSec）
type SalesGenerateBase = {
  publicId: string
  aspectRatio?: VideoAspectRatio
  resolution?: string
  generateAudio: boolean
  referenceImages: { url: string }[]
}

// 含分镜的向导（loadOwnedWorkflow 的返回形状，generate 各策略与 getWorkflow 共用）
type SalesWorkflowWithSegments = Prisma.SalesWorkflowGetPayload<{
  include: {
    project: { select: { id: true; name: true; type: true } }
    segments: true
  }
}>

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly videoService: VideoProjectService,
    private readonly gatewayWebhook: AiGatewayWebhookService
  ) {}

  // ==================== 项目 ====================

  /** 新建带货项目：VideoProject(type=ECOMMERCE) + 空 SalesWorkflow */
  createProject(dto: CreateSalesProjectDto, userId: number) {
    return this.prisma.videoProject.create({
      data: {
        name: dto.name?.trim() || "未命名项目",
        type: "ECOMMERCE",
        userId,
        salesWorkflow: { create: { userId } },
      },
      include: { salesWorkflow: true },
    })
  }

  /** 拉向导 + 校验归属（含 project、分镜，不含出片历史），getWorkflow 与 generate 共用 */
  private async loadOwnedWorkflow(
    projectId: number,
    userId: number
  ): Promise<SalesWorkflowWithSegments> {
    const wf = await this.prisma.salesWorkflow.findUnique({
      where: { projectId },
      include: {
        project: { select: { id: true, name: true, type: true } },
        segments: { orderBy: { order: "asc" } },
      },
    })
    if (!wf) throw new NotFoundException("带货项目不存在")
    this.ensureOwner(wf.userId, userId)
    return wf
  }

  /** 读整份向导状态（segments=脚本，outputs=成片版本列表；用于回显/返回上一步/成片预览轮询） */
  async getWorkflow(projectId: number, userId: number) {
    const wf = await this.loadOwnedWorkflow(projectId, userId)
    let tasks = await this.loadTasks(wf.id)

    // 读时对账：成片预览轮询时对 GENERATING 行顺带查网关（Gateway 回调丢失时自愈），对账后重读
    const generating = tasks.filter(task => task.status === "GENERATING" && task.gatewayTaskId)
    if (generating.length) {
      await Promise.all(
        generating.map(task => this.gatewayWebhook.reconcileVideoTaskOnRead(task))
      )
      tasks = await this.loadTasks(wf.id)
    }
    const names = await modelDisplayNames(this.prisma, tasks.map(t => t.model))
    return { ...wf, outputs: this.buildOutputs(tasks, names) }
  }

  /** 取该向导全部出片任务（软删已过滤），按 createdAt 倒序（同槽最新在前） */
  private loadTasks(workflowId: number) {
    return this.prisma.videoTask.findMany({
      where: { salesWorkflowId: workflowId, source: "platform", project: { source: "platform" } },
      select: SEGMENT_TASK_SELECT,
      orderBy: { createdAt: "desc" },
    })
  }

  /**
   * 把全部出片任务按批次（salesBatchNo）归成一份份连贯成片版本，最新版本在前。
   * 同一批次内按 segmentOrder 取每段最新一条（段内重试覆盖旧的失败记录），
   * 一键成片该批次仅 1 条（segmentOrder=null）。startSec/endSec 按段时长在版本内累计得出。
   */
  private buildOutputs(tasks: SalesVideoTask[], names: Map<string, string> = new Map()): SalesOutputVersion[] {
    // tasks 已按 createdAt 倒序：按批次归组，同批次内每个 segmentOrder 仅留最新一条
    const byBatch = new Map<number, Map<number | null, SalesVideoTask>>()
    for (const task of tasks) {
      const batch = byBatch.get(batchOf(task)) ?? new Map<number | null, SalesVideoTask>()
      if (!byBatch.has(batchOf(task))) byBatch.set(batchOf(task), batch)
      if (!batch.has(task.segmentOrder)) batch.set(task.segmentOrder, task)
    }

    return [...byBatch.entries()]
      .sort(([a], [b]) => b - a) // 批次号大的（最新）在前
      .map(([batchNo, segMap]) => {
        const ordered = [...segMap.values()].sort(
          (a, b) => (a.segmentOrder ?? 0) - (b.segmentOrder ?? 0)
        )
        let acc = 0
        const videos: SalesOutputVideo[] = ordered.map(t => {
          const startSec = acc
          acc += t.durationSec ?? 0
          return {
            segmentOrder: t.segmentOrder,
            startSec,
            endSec: acc,
            taskId: t.id,
            status: t.status,
            prompt: t.prompt,
            resultUrl: t.resultUrl,
            thumbnailUrl: t.thumbnailUrl,
            publicId: t.model,
            displayName: names.get(t.model) ?? t.modelName ?? t.model,
            mode: t.mode,
            ...videoMetadata(t.generationParams, t.deliveryMeta),
            durationSec: t.durationSec,
            aspectRatio: t.aspectRatio,
            resolution: t.resolution,
            errorMessage: t.errorMessage,
            gatewayError: t.gatewayError,
            createdAt: t.createdAt,
          }
        })
        // 版本时间取该批次最新任务（tasks 倒序 → ordered 里 createdAt 最大者）
        const createdAt = ordered.reduce(
          (max, t) => (t.createdAt > max ? t.createdAt : max),
          ordered[0].createdAt
        )
        return { batchNo, createdAt, videos }
      })
  }

  // ==================== Step1 产品 & 痛点 ====================

  async saveProduct(projectId: number, dto: SaveSalesProductDto, userId: number) {
    const wf = await this.assertWorkflowOwned(projectId, userId)
    const data: Prisma.SalesWorkflowUpdateInput = {}
    if (dto.productImages !== undefined) data.productImages = dto.productImages as unknown as Json
    if (dto.infoSource !== undefined) data.infoSource = dto.infoSource
    if (dto.textInput !== undefined) data.textInput = dto.textInput
    if (dto.sourceUrl !== undefined) data.sourceUrl = dto.sourceUrl
    if (dto.manualFileUrl !== undefined) data.manualFileUrl = dto.manualFileUrl
    if (dto.productInfo !== undefined) data.productInfo = dto.productInfo as Json
    if (dto.painPoints !== undefined) data.painPoints = dto.painPoints as unknown as Json
    await this.prisma.salesWorkflow.update({ where: { id: wf.id }, data })
    return this.getWorkflow(projectId, userId)
  }

  // ==================== Step2 选素材 ====================

  async saveMaterials(projectId: number, dto: SaveSalesMaterialsDto, userId: number) {
    const wf = await this.assertWorkflowOwned(projectId, userId)
    const data: Prisma.SalesWorkflowUpdateInput = {}
    // 传 null 清除选择；省略则不动
    if (dto.digitalHuman !== undefined) {
      data.digitalHuman =
        dto.digitalHuman === null ? Prisma.JsonNull : (dto.digitalHuman as unknown as Json)
    }
    if (dto.scene !== undefined) {
      data.scene = dto.scene === null ? Prisma.JsonNull : (dto.scene as unknown as Json)
    }
    await this.prisma.salesWorkflow.update({ where: { id: wf.id }, data })
    return this.getWorkflow(projectId, userId)
  }

  // ==================== Step3 生成脚本（保存配置 + 分镜） ====================

  async saveScript(projectId: number, dto: SaveSalesScriptDto, userId: number) {
    const wf = await this.assertWorkflowOwned(projectId, userId)
    const data: Prisma.SalesWorkflowUpdateInput = {}
    if (dto.model !== undefined) data.model = dto.model
    if (dto.totalDuration !== undefined) data.totalDuration = dto.totalDuration
    if (dto.generateAudio !== undefined) data.generateAudio = dto.generateAudio
    if (dto.aspectRatio !== undefined) data.aspectRatio = dto.aspectRatio
    if (dto.resolution !== undefined) data.resolution = dto.resolution

    await this.prisma.$transaction(async tx => {
      await tx.salesWorkflow.update({ where: { id: wf.id }, data })
      // 传入 segments 即全量替换（重新生成脚本会覆盖旧分镜；旧分镜已生成的视频任务保留在任务中心）
      if (dto.segments !== undefined) {
        await tx.salesSegment.deleteMany({ where: { workflowId: wf.id } })
        if (dto.segments.length) {
          await tx.salesSegment.createMany({
            data: dto.segments.map(s => ({
              workflowId: wf.id,
              order: s.order,
              startSec: s.startSec,
              endSec: s.endSec,
              vidPrompt: s.vidPrompt,
              voiceover: s.voiceover,
            })),
          })
        }
      }
    })
    return this.getWorkflow(projectId, userId)
  }

  // ==================== Step4 确认出片（一键成片 / 分段生成） ====================

  async generate(projectId: number, dto: GenerateSalesDto, userId: number) {
    const wf = await this.loadOwnedWorkflow(projectId, userId)
    if (!wf.model) throw new BadRequestException("请先在「生成脚本」步骤选择模型")
    if (!wf.segments.length) throw new BadRequestException("请先生成分镜脚本")

    const model = await this.prisma.aiGatewayModel.findFirst({
      where: {
        publicId: wf.model,
        category: "REFERENCE",
        modality: AiModelModality.VIDEO,
        execMode: AiModelExecMode.ASYNC,
        enabled: true,
        gatewayActive: true,
      },
      select: { publicId: true, gatewayConfig: true },
    })
    if (!model) throw new BadRequestException("所选模型不支持全能参考模式")
    const durationOptions = this.modelDurations(model.gatewayConfig)

    const referenceImages = this.buildReferenceImages(wf)

    // 成片方式：请求显式指定则覆盖，否则沿用上次（默认 ONESHOT）
    const outputMode = dto.outputMode ?? (wf.outputMode as "ONESHOT" | "SEGMENTED")
    if (outputMode !== wf.outputMode) {
      await this.prisma.salesWorkflow.update({ where: { id: wf.id }, data: { outputMode } })
    }

    const base = {
      publicId: model.publicId,
      aspectRatio: (wf.aspectRatio as VideoAspectRatio | null) ?? undefined,
      resolution: wf.resolution ?? undefined,
      generateAudio: wf.generateAudio,
      referenceImages,
    }

    // 每次点击生成都另起新成片版本，全量重新出片；旧批次保留为历史版本。
    const tasks = await this.loadTasks(wf.id)
    const maxBatch = tasks.reduce((m, t) => Math.max(m, batchOf(t)), 0)
    const batchNo = maxBatch + 1
    const latestInBatch = new Map<number | null, SalesVideoTask>()

    if (outputMode === "ONESHOT") {
      await this.generateOneShot(
        wf,
        base,
        durationOptions,
        userId,
        batchNo,
        latestInBatch.get(null)
      )
    } else {
      await this.generateSegmented(wf, base, durationOptions, userId, batchNo, latestInBatch)
    }

    return this.getWorkflow(projectId, userId)
  }

  /** 一键成片：拼接全部分镜为单个 REFERENCE 任务，挂到向导名下（落入指定批次） */
  private async generateOneShot(
    wf: SalesWorkflowWithSegments,
    base: SalesGenerateBase,
    durationOptions: number[],
    userId: number,
    batchNo: number,
    current?: SalesVideoTask
  ) {
    if (current && !REGENERATABLE_STATUSES.has(current.status)) return // 当前版本已成功/运行中：跳过

    const prompt = this.buildOneShotPrompt(wf.segments)
    const durationSec = this.snapDuration(wf.totalDuration ?? 0, durationOptions)
    const task = await this.videoService.createTask(
      wf.projectId,
      this.toGatewayRequest(base, prompt, durationSec),
      userId
    )
    // 在新任务上回填锚点（不动旧任务）→ 历史版本保留
    await this.prisma.videoTask.update({
      where: { id: task.id },
      data: { salesWorkflowId: wf.id, salesBatchNo: batchNo },
    })
    this.logger.log(`[Sales] 一键成片 projectId=${wf.projectId} batch=${batchNo} → task=${task.id}`)
  }

  /** 分段生成：每个分镜建一个 REFERENCE 任务，当前批次内已成功/运行中的分镜跳过 */
  private async generateSegmented(
    wf: SalesWorkflowWithSegments,
    base: SalesGenerateBase,
    durationOptions: number[],
    userId: number,
    batchNo: number,
    latestInBatch: Map<number | null, SalesVideoTask>
  ) {
    for (const seg of wf.segments) {
      const current = latestInBatch.get(seg.order) // 当前批次该段最新一条
      if (current && !REGENERATABLE_STATUSES.has(current.status)) continue // 已成功/运行中：跳过

      const durationSec = this.snapDuration(seg.endSec - seg.startSec, durationOptions)
      const prompt = this.buildSegmentPrompt(seg.vidPrompt, seg.voiceover)
      const task = await this.videoService.createTask(
        wf.projectId,
        this.toGatewayRequest(base, prompt, durationSec),
        userId
      )
      // 锚在向导上 + segmentOrder 标记归属分镜 + 批次号归属该次成片（不动旧任务）。
      // 即使后续 saveScript 删掉分镜行，历史仍挂在 workflow 上不丢。
      await this.prisma.videoTask.update({
        where: { id: task.id },
        data: { salesWorkflowId: wf.id, segmentOrder: seg.order, salesBatchNo: batchNo },
      })
      this.logger.log(
        `[Sales] 分镜出片 projectId=${wf.projectId} batch=${batchNo} segment=${seg.id} → task=${task.id}`
      )
    }
  }

  // ==================== 私有 ====================

  /** 一键成片：把全部分镜按时间顺序拼成单条提示词（画面 + 口播） */
  private buildOneShotPrompt(segments: SalesWorkflowWithSegments["segments"]): string {
    return segments
      .map((s, i) => {
        const head = `分镜${i + 1}（${s.startSec}-${s.endSec}s）：`
        return `${head}\n${this.buildSegmentPrompt(s.vidPrompt, s.voiceover)}`
      })
      .join("\n\n")
  }

  /** 分镜提示词：画面提示 + 口播（有口播时合并，确保分段/一键口径一致） */
  private buildSegmentPrompt(vidPrompt: string, voiceover?: string | null): string {
    return voiceover ? `${vidPrompt}\n口播：${voiceover}` : vidPrompt
  }

  private buildReferenceImages(wf: {
    productImages: unknown
    digitalHuman: unknown
    scene: unknown
  }) {
    const refs: { url: string }[] = []
    const images = (wf.productImages as { url?: string; name?: string }[] | null) ?? []
    images.forEach(img => {
      if (img?.url) refs.push({ url: img.url })
    })
    const human = wf.digitalHuman as { name?: string; portraitUrl?: string } | null
    if (human?.portraitUrl) refs.push({ url: human.portraitUrl })
    const scene = wf.scene as { name?: string; imageUrl?: string } | null
    if (scene?.imageUrl) refs.push({ url: scene.imageUrl })
    return refs
  }

  private toGatewayRequest(base: SalesGenerateBase, prompt: string, durationSec?: number) {
    return {
      category: "REFERENCE",
      publicId: base.publicId,
      params: {
        prompt,
        mode: "reference_to_video" as const,
        ...(durationSec != null ? { duration_seconds: durationSec } : {}),
        ...(base.aspectRatio ? { aspect_ratio: base.aspectRatio } : {}),
        ...(base.resolution ? { resolution: base.resolution } : {}),
        generate_audio: base.generateAudio,
        reference_images: base.referenceImages,
      },
    }
  }

  private modelDurations(gatewayConfig: Prisma.JsonValue): number[] {
    if (!gatewayConfig || typeof gatewayConfig !== "object" || Array.isArray(gatewayConfig))
      return []
    const detail = gatewayConfig.detail
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return []
    const facts = detail.facts
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) return []
    return Array.isArray(facts.durations)
      ? facts.durations.filter(
          (duration): duration is number => typeof duration === "number" && duration > 0
        )
      : []
  }

  /** 把请求时长对齐到模型允许档位（取最接近）；无时长参数的模型返回 undefined */
  private snapDuration(requested: number, options: number[]): number | undefined {
    if (!options.length) return undefined
    return options.reduce((best, o) =>
      Math.abs(o - requested) < Math.abs(best - requested) ? o : best
    )
  }

  private async assertWorkflowOwned(projectId: number, userId: number) {
    const wf = await this.prisma.salesWorkflow.findUnique({
      where: { projectId },
      select: { id: true, userId: true },
    })
    if (!wf) throw new NotFoundException("带货项目不存在")
    this.ensureOwner(wf.userId, userId)
    return wf
  }

  private ensureOwner(ownerId: number, userId: number) {
    if (ownerId !== userId) throw new ForbiddenException("无权访问该资源")
  }
}
