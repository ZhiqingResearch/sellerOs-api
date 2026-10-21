import { chetaidouImageJobStatus } from "../chetaidou.constants"
// 车泰斗素材工作台 — 生图执行器（方案 §7.5）
// 扫描 businessType=CHETAIDOU 的 ImageGenJob/Item；每张独立 Call：
// createImageTask(operation=edit, 原图 reference, callback:true, 幂等键
// chetaidou:call:<callId>) → 回执落库（webhook 先行/轮询兜底同一路径）→
// 下载校验 → 私有转存 → 事务结算+更新 Item → 聚合 Job。
// 不调用旧 ImageGenItemRunner；Item 的 leaseOwner/attemptNo 不参与决策。
import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import type { ImageTask } from "@zhiqingresearch/ai-ts-sdk"
import axios from "axios"
import { randomUUID } from "crypto"
import { AiGatewayProvider } from "../../ai-gateway/ai-gateway.provider"
import { ChetaidouGatewayReceiptService } from "../../ai-gateway/chetaidou-gateway-receipt.service"
import { resolveGatewaySizingIntentDetailed } from "../../ai-gateway/gateway-image-sizing"
import { PrismaService } from "../../prisma/prisma.service"
import { ChetaidouBillingService } from "../chetaidou-billing.service"
import { TaskSnapshot } from "../chetaidou-context.service"
import { ChetaidouStorageService, originalImageOf, stableHash } from "../chetaidou-storage.service"
import {
  CHETAIDOU_BUSINESS_TYPE,
  CHETAIDOU_CALL_PREFIX,
  CHETAIDOU_ERROR_CODES,
  CHETAIDOU_SCAN_INTERVAL_MS,
  CHETAIDOU_USAGE_SOURCES,
  chetaidouImageDeadlineMs,
} from "../chetaidou.constants"
import { CHETAIDOU_PROMPT_VERSION } from "../chetaidou.prompts"
import { prepareChetaidouImage } from "./chetaidou-image-delivery"

const BACKSTOP_POLL_MS = Number(process.env.CHETAIDOU_IMAGE_POLL_MS) || 10_000

type ItemRow = Prisma.ImageGenItemGetPayload<Record<string, never>>
type JobRow = Prisma.ImageGenJobGetPayload<{ include: { items: true } }>

@Injectable()
export class ChetaidouImageRunnerService implements OnModuleInit {
  private readonly logger = new Logger(ChetaidouImageRunnerService.name)
  private scanTimer: NodeJS.Timeout | null = null
  private readonly inFlight = new Set<number>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayProvider,
    private readonly receipts: ChetaidouGatewayReceiptService,
    private readonly billing: ChetaidouBillingService,
    private readonly storage: ChetaidouStorageService
  ) {}

  onModuleInit(): void {
    this.scanTimer = setInterval(() => {
      void this.scan().catch(err => this.logger.error(`图片扫描失败：${errMessage(err)}`))
    }, CHETAIDOU_SCAN_INTERVAL_MS)
    this.scanTimer.unref?.()
    void this.scan().catch(() => undefined)
  }

  async scan(): Promise<void> {
    const items = await this.prisma.imageGenItem.findMany({
      where: {
        status: { in: ["QUEUED", "RUNNING", "SETTLING", "DELIVERY_PENDING"] },
        job: { businessType: CHETAIDOU_BUSINESS_TYPE, status: { not: "CANCELLED" } },
      },
      orderBy: { id: "asc" },
      select: { id: true },
    })
    for (const item of items) {
      if (this.inFlight.has(item.id)) continue
      this.inFlight.add(item.id)
      void this.executeItem(item.id)
        .catch(err => this.logger.error(`图片 ${item.id} 执行异常：${errMessage(err)}`))
        .finally(() => {
          this.inFlight.delete(item.id)
        })
    }
  }

  async executeItem(itemId: number): Promise<void> {
    const item = await this.prisma.imageGenItem.findUnique({ where: { id: itemId } })
    if (!item) return
    const job = await this.prisma.imageGenJob.findUnique({
      where: { id: item.jobId },
      include: { items: true },
    })
    if (!job || job.businessType !== CHETAIDOU_BUSINESS_TYPE) return
    if (job.cancelRequestedAt && item.status === "QUEUED") {
      await this.prisma.imageGenItem.updateMany({
        where: { id: item.id, status: "QUEUED" },
        data: { status: "CANCELLED" },
      })
      await this.aggregateJob(job.id)
      return
    }
    const task = await this.prisma.chetaidouTask.findFirst({
      where: { imageGenJobId: job.id, type: "GENERATE" },
      orderBy: { createdAt: "asc" },
    })
    if (!task) return
    const snapshot = task.snapshot as unknown as TaskSnapshot
    const request = job.request as {
      prompt: string
      sourceFileKey: string
      quality?: string
      referenceFileKeys?: string[]
      resolution?: string
    }
    const deadlineAt = new Date(item.updatedAt.getTime() + chetaidouImageDeadlineMs())

    // 状态分派
    if (
      item.status === "RUNNING" ||
      item.status === "SETTLING" ||
      item.status === "DELIVERY_PENDING"
    ) {
      await this.resumeItem({ item, job, task, snapshot, request, deadlineAt })
      return
    }
    // 认领与 Call 落库原子完成，其他扫描器不会看到 RUNNING 但缺 Call 的中间状态。
    const call = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ImageGenJob WHERE id = ${job.id} FOR UPDATE`
      const claimed = await tx.imageGenItem.updateMany({
        where: { id: item.id, status: "QUEUED" },
        data: { status: "RUNNING" },
      })
      if (claimed.count === 0) return null
      return this.openImageCall(task, job, item, tx)
    })
    if (!call) return
    if (call instanceof Error) {
      await this.failItem(item.id, "PROVIDER_ERROR", call.message, job.id)
      return
    }
    await this.submitAndWait({
      taskId: task.id,
      callId: call.id,
      job,
      itemId: item.id,
      snapshot,
      request,
      deadlineAt,
      previousGatewayTaskId: call.gatewayTaskId,
    })
  }

  private async resumeItem(ctx: {
    item: ItemRow
    job: JobRow
    task: Prisma.ChetaidouTaskGetPayload<Record<string, never>>
    snapshot: TaskSnapshot
    request: { prompt: string; sourceFileKey: string; referenceFileKeys?: string[]; quality?: string; resolution?: string }
    deadlineAt: Date
  }): Promise<void> {
    const call = await this.prisma.chetaidouCall.findFirst({
      where: { imageGenItemId: ctx.item.id },
      orderBy: { attempt: "desc" },
    })
    if (!call) {
      // RUNNING 但无 Call：回到 QUEUED 重新创建（未发模型不收费）
      await this.prisma.imageGenItem.updateMany({
        where: { id: ctx.item.id, status: "RUNNING" },
        data: { status: "QUEUED" },
      })
      return
    }
    if (call.state === "UNKNOWN") {
      await this.markItemUnknown(ctx.item.id, ctx.job.id)
      return
    }
    if (call.state === "SUBMITTING" && !call.gatewayTaskId) {
      // 其他执行者可能还在提交；只等待，不能把正常在途请求当成失联后重新发起。
      if (Date.now() < ctx.deadlineAt.getTime()) return
      await this.prisma.chetaidouCall.update({
        where: { id: call.id },
        data: { state: "UNKNOWN", errorCode: "CALL_STATUS_UNKNOWN" },
      })
      await this.markItemUnknown(ctx.item.id, ctx.job.id)
      return
    }
    await this.submitAndWait({
      taskId: ctx.task.id,
      callId: call.id,
      job: ctx.job,
      itemId: ctx.item.id,
      snapshot: ctx.snapshot,
      request: ctx.request,
      deadlineAt: ctx.deadlineAt,
      previousGatewayTaskId: call.gatewayTaskId,
    })
  }

  /** 提交（若未提交）并等待终态 → 转存 → 结算 */
  private async submitAndWait(ctx: {
    taskId: string
    callId: string
    job: JobRow
    itemId: number
    snapshot: TaskSnapshot
    request: { prompt: string; sourceFileKey: string; referenceFileKeys?: string[]; quality?: string; resolution?: string }
    deadlineAt: Date
    previousGatewayTaskId: string | null
  }): Promise<void> {
    const call = await this.prisma.chetaidouCall.findUnique({ where: { id: ctx.callId } })
    if (!call) return
    let gatewayTaskId = call.gatewayTaskId

    if (!gatewayTaskId) {
      // 本地准备在 CAS 前完成：未请求供应商的失败不能误标 UNKNOWN。
      let imageUrls: string[]
      let sizing: Record<string, unknown>
      try {
        imageUrls = await Promise.all([ctx.request.sourceFileKey, ...(ctx.request.referenceFileKeys ?? [])].map(key => this.storage.signForModel(key)))
        sizing = this.planSizing(ctx.snapshot, ctx.request.resolution)
      } catch (error) {
        const failed = await this.prisma.$transaction(async tx => {
          const claimed = await tx.chetaidouCall.updateMany({
            where: { id: ctx.callId, state: "PREPARED" },
            data: {
              state: "FINISHED",
              outcome: "PROVIDER_FAILED",
              billingStatus: "FREE",
              errorCode: "IMAGE_PREPARATION_FAILED",
              errorMessage: errMessage(error).slice(0, 1000),
              finishedAt: new Date(),
            },
          })
          if (claimed.count)
            await tx.imageGenItem.update({
              where: { id: ctx.itemId },
              data: {
                status: "FAILED",
                errorCode: "IMAGE_PREPARATION_FAILED",
                errorMessage: errMessage(error).slice(0, 1000),
              },
            })
          return claimed.count
        })
        if (failed) await this.aggregateJob(ctx.job.id)
        return
      }
      // 提交前：CAS PREPARED→SUBMITTING，只发一次
      const submit = await this.prisma.chetaidouCall.updateMany({
        where: { id: ctx.callId, state: "PREPARED" },
        data: { state: "SUBMITTING", submittedAt: new Date() },
      })
      if (submit.count > 0) {
        const params = {
          model: ctx.snapshot.models.image.publicId,
          prompt: ctx.request.prompt,
          operation: "edit" as const,
          n: 1 as const,
          response_format: "url" as const,
          callback: true,
          reference_images: imageUrls!.map(url => ({ url })),
          ...sizing,
          ...ctx.snapshot.generation?.providerDefaults,
          ...legacyQuality(ctx.snapshot.generation?.quality ?? ctx.request.quality),
        }
        try {
          const created = await this.gateway.createImageTask(
            params as never,
            `${CHETAIDOU_CALL_PREFIX}${ctx.callId}`
          )
          gatewayTaskId = created.id
          await this.prisma.chetaidouCall.update({
            where: { id: ctx.callId },
            data: { gatewayTaskId, state: "WAITING" },
          })
          await this.prisma.imageGenItem.update({
            where: { id: ctx.itemId },
            data: { providerJobId: gatewayTaskId },
          })
        } catch (error) {
          await this.prisma.chetaidouCall.update({
            where: { id: ctx.callId },
            data: {
              state: "UNKNOWN",
              errorCode: "CALL_STATUS_UNKNOWN",
              errorMessage: errMessage(error).slice(0, 1000),
            },
          })
          await this.markItemUnknown(ctx.itemId, ctx.job.id)
          return
        }
      } else {
        // 他人已提交：重读
        const reread = await this.prisma.chetaidouCall.findUnique({ where: { id: ctx.callId } })
        if (!reread?.gatewayTaskId) return
        gatewayTaskId = reread.gatewayTaskId
      }
    }

    // 等待终态：轮询 Call（webhook 已更新）+ 主动 getImageTask 兜底
    const terminal = await this.waitTerminal(ctx.callId, gatewayTaskId, ctx.deadlineAt)
    if (!terminal) {
      // 超时仍非终态：UNKNOWN（不假设失败/免单）
      await this.prisma.chetaidouCall.update({
        where: { id: ctx.callId },
        data: { state: "UNKNOWN", errorCode: "PROVIDER_TIMEOUT" },
      })
      await this.markItemUnknown(ctx.itemId, ctx.job.id)
      return
    }
    if (terminal.status === "succeeded") {
      const images =
        terminal.result && "images" in terminal.result ? terminal.result.images : undefined
      const artifact = images?.[0]
      if (!artifact?.url) {
        await this.settleFailure(ctx, terminal, "网关成功但缺少产物 URL")
        return
      }
      await this.deliverArtifact(ctx, terminal, artifact.url)
      return
    }
    if (terminal.status === "canceled") {
      await this.settleCancel(ctx, terminal)
      return
    }
    // failed / expired
    const message =
      "error" in terminal
        ? `${terminal.error?.code ?? ""} ${terminal.error?.message ?? ""}`.trim()
        : "生成失败"
    await this.settleFailure(ctx, terminal, message || "生成失败")
  }

  /** 新任务使用冻结规划；历史任务兼容母版比例与原尺寸快照。 */
  private planSizing(snapshot: TaskSnapshot, requestResolution?: string): Record<string, unknown> {
    if (snapshot.generation?.providerApplied) return { ...snapshot.generation.providerApplied }
    const { width, height } = snapshot.image
    const ratio = `${width}:${height}`
    const plan = resolveGatewaySizingIntentDetailed({
      aspectRatio: ratio,
      resolutionTier:
        snapshot.generation?.resolutionTier ??
        snapshot.generation?.resolution ??
        requestResolution ??
        "1K",
      modelId: snapshot.models.image.publicId,
    })
    if (!plan.sizing.size && !plan.sizing.aspect_ratio) {
      throw new Error("该母版长宽比无法被当前模型表达，请维护方调整输入")
    }
    return plan.sizing as Record<string, unknown>
  }

  private async waitTerminal(
    callId: string,
    gatewayTaskId: string,
    deadline: Date
  ): Promise<ImageTask | null> {
    while (Date.now() < deadline.getTime()) {
      const call = await this.prisma.chetaidouCall.findUnique({ where: { id: callId } })
      const fromReceipt = readTerminal(call?.gatewayResponse as unknown as ImageTask | null)
      if (fromReceipt) return fromReceipt
      // 主动查询并保存回执（与 webhook 同一保存路径）
      try {
        const task = await this.gateway.getImageTask(gatewayTaskId)
        await this.receipts.persistImageTaskReceipt(task)
        const terminal = readTerminal(task)
        if (terminal) return terminal
      } catch (error) {
        this.logger.warn(`查询网关任务 ${gatewayTaskId} 失败（继续等待）：${errMessage(error)}`)
      }
      await sleep(BACKSTOP_POLL_MS)
    }
    // deadline 到点最后查一次
    try {
      const task = await this.gateway.getImageTask(gatewayTaskId)
      await this.receipts.persistImageTaskReceipt(task)
      return readTerminal(task)
    } catch {
      return null
    }
  }

  /** 保存未加工原图 → 处理并保存成品 → 事务结算 + 更新 Item → 聚合 Job */
  private async deliverArtifact(
    ctx: {
      callId: string
      job: JobRow
      itemId: number
      snapshot: TaskSnapshot
    },
    task: ImageTask,
    url: string
  ): Promise<void> {
    try {
      const item = await this.prisma.imageGenItem.findUnique({ where: { id: ctx.itemId } })
      let original = originalImageOf(item?.gatewayImage)
      let bytes: Buffer
      // 同一次调用的交付重试复用已保存原图，不依赖网关临时链接。
      if (original?.callId === ctx.callId) {
        bytes = await this.downloadArtifact(await this.storage.signDownload(original.fileKey))
      } else {
        bytes = await this.downloadArtifact(url)
        const asset = await this.storage.validateImage(bytes)
        const extension = asset.mime === "image/jpeg" ? "jpg" : asset.mime.slice("image/".length)
        original = {
          callId: ctx.callId,
          fileKey: this.storage.artifactFileKey(ctx.callId, extension, "original"),
          mime: asset.mime,
          width: asset.width,
          height: asset.height,
        }
        await this.storage.hostArtifact(bytes, original.fileKey, original.mime)
        await this.prisma.imageGenItem.update({
          where: { id: ctx.itemId },
          data: {
            gatewayImage: { original, nativeWidth: asset.width, nativeHeight: asset.height },
          },
        })
      }
      // 留存终态回执，使成品交付失败后的重试也可脱离网关恢复。
      await this.prisma.chetaidouCall.update({
        where: { id: ctx.callId },
        data: { gatewayResponse: task as unknown as object },
      })
      const delivered = await prepareChetaidouImage(bytes, ctx.snapshot)
      const fileKey = this.storage.artifactFileKey(ctx.callId, delivered.extension)
      const mime = delivered.mime
      await this.storage.hostArtifact(delivered.bytes, fileKey, mime)
      const usage = "usage" in task && task.usage ? task.usage : undefined
      const amount = usage?.amount ? toDecimal(usage.amount) : null
      // 事务：锁 Task→Job→Call→Item；结算 + 更新 Item
      await this.prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT id FROM ChetaidouTask WHERE id = ${ctx.job.businessTaskId} FOR UPDATE`
          const job = await tx.imageGenJob.findUnique({ where: { id: ctx.job.id } })
          if (!job) throw new Error("批次不存在")
          const call = await tx.chetaidouCall.findUnique({ where: { id: ctx.callId } })
          if (!call) throw new Error("Call 不存在")
          await this.billing.settleImageInTx(
            tx,
            {
              id: ctx.callId,
              taskId: call.taskId,
              rootTaskId: call.rootTaskId,
              ownerId: call.ownerId,
              imageGenItemId: ctx.itemId,
              model: call.model,
            },
            amount,
            true
          )
          await tx.chetaidouCall.update({
            where: { id: ctx.callId },
            data: {
              state: "FINISHED",
              outcome: "ACCEPTED",
              artifactFileKey: fileKey,
              errorCode: null,
              errorMessage: null,
              finishedAt: new Date(),
            },
          })
          await tx.imageGenItem.update({
            where: { id: ctx.itemId },
            data: {
              status: "SUCCEEDED",
              fileKey,
              mime,
              width: delivered.width,
              height: delivered.height,
              errorMessage: null,
              errorCode: null,
              gatewayImage: {
                ...delivered.generationMeta,
                original,
              },
              currentCallId: ctx.callId,
            },
          })
        },
        { timeout: 60_000 }
      )
    } catch (error) {
      // 交付未成功不能独立扣费；恢复原产物，交付与结算同事务提交，不重新生图。
      this.logger.error(`产物交付失败 ${ctx.itemId}：${errMessage(error)}`)
      await this.prisma.$transaction(async tx => {
        await tx.imageGenItem.update({
          where: { id: ctx.itemId },
          data: {
            status: "DELIVERY_PENDING",
            errorCode: "DELIVERY_PENDING",
            errorMessage: `产物转存失败：${errMessage(error)}`.slice(0, 1000),
          },
        })
      })
    }
    await this.aggregateJob(ctx.job.id)
  }

  /** 失败免费，网关实际成本仅供内部对账。 */
  private async settleFailure(
    ctx: { callId: string; job: JobRow; itemId: number },
    task: ImageTask,
    message: string
  ): Promise<void> {
    const usage = "usage" in task && task.usage ? task.usage : undefined
    const amount = usage?.amount ? toDecimal(usage.amount) : null
    await this.prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM ChetaidouTask WHERE id = ${ctx.job.businessTaskId} FOR UPDATE`
        const call = await tx.chetaidouCall.findUnique({ where: { id: ctx.callId } })
        if (!call) return
        await this.billing.settleImageInTx(
          tx,
          {
            id: ctx.callId,
            taskId: call.taskId,
            rootTaskId: call.rootTaskId,
            ownerId: call.ownerId,
            imageGenItemId: ctx.itemId,
            model: call.model,
          },
          amount,
          false
        )
        await tx.chetaidouCall.update({
          where: { id: ctx.callId },
          data: {
            state: "FINISHED",
            outcome: "PROVIDER_FAILED",
            errorCode: "PROVIDER_ERROR",
            errorMessage: message.slice(0, 1000),
            finishedAt: new Date(),
          },
        })
        await tx.imageGenItem.update({
          where: { id: ctx.itemId },
          data: {
            status: "FAILED",
            errorCode: "PROVIDER_ERROR",
            errorMessage: message.slice(0, 1000),
          },
        })
      },
      { timeout: 60_000 }
    )
    await this.aggregateJob(ctx.job.id)
  }

  private async settleCancel(
    ctx: { callId: string; job: JobRow; itemId: number },
    task: ImageTask
  ): Promise<void> {
    const usage = "usage" in task && task.usage ? task.usage : undefined
    await this.prisma.$transaction(async tx => {
      const call = await tx.chetaidouCall.findUnique({ where: { id: ctx.callId } })
      if (!call) return
      await this.billing.settleImageInTx(
        tx,
        {
          id: ctx.callId,
          taskId: call.taskId,
          rootTaskId: call.rootTaskId,
          ownerId: call.ownerId,
          imageGenItemId: ctx.itemId,
          model: call.model,
        },
        usage?.amount ? toDecimal(usage.amount) : null,
        false
      )
      await tx.chetaidouCall.update({
        where: { id: ctx.callId },
        data: { state: "FINISHED", outcome: "CANCELLED", finishedAt: new Date() },
      })
      await tx.imageGenItem.update({
        where: { id: ctx.itemId },
        data: { status: "CANCELLED" },
      })
    })
    await this.aggregateJob(ctx.job.id)
  }

  private async markItemUnknown(itemId: number, jobId: string): Promise<void> {
    await this.prisma.imageGenItem
      .update({
        where: { id: itemId },
        data: {
          status: "UNKNOWN",
          errorCode: "CALL_STATUS_UNKNOWN",
          errorMessage: "供应商接收状态待核对",
        },
      })
      .catch(() => undefined)
    await this.aggregateJob(jobId)
  }

  private async failItem(
    itemId: number,
    errorCode: string,
    message: string,
    jobId: string
  ): Promise<void> {
    await this.prisma.imageGenItem.update({
      where: { id: itemId },
      data: { status: "FAILED", errorCode, errorMessage: message.slice(0, 1000) },
    })
    await this.aggregateJob(jobId)
  }

  /** 聚合 Job 状态（持 Job 行锁后读取全部当前 Item 状态再更新） */
  async aggregateJob(jobId: string): Promise<void> {
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ImageGenJob WHERE id = ${jobId} FOR UPDATE`
      const job = await tx.imageGenJob.findUnique({ where: { id: jobId } })
      if (!job || job.businessType !== CHETAIDOU_BUSINESS_TYPE) return
      const items = await tx.imageGenItem.findMany({ where: { jobId } })
      const status = chetaidouImageJobStatus(items)
      await tx.imageGenJob.update({
        where: { id: jobId },
        data: { status },
        ...(status !== "RUNNING" ? {} : {}),
      })
    })
  }

  private async openImageCall(
    task: Prisma.ChetaidouTaskGetPayload<Record<string, never>>,
    job: JobRow,
    item: ItemRow,
    tx: Prisma.TransactionClient
  ): Promise<{ id: string; gatewayTaskId: string | null } | Error> {
    const pending = await tx.chetaidouCall.findFirst({
      where: { imageGenItemId: item.id },
      orderBy: { attempt: "desc" },
    })
    if (pending && ["PREPARED", "SUBMITTING", "WAITING", "RECEIVED"].includes(pending.state)) {
      return { id: pending.id, gatewayTaskId: pending.gatewayTaskId }
    }
    if (pending && pending.state === "UNKNOWN") {
      return new Error("该图片存在状态未知的调用，需人工核对后重试")
    }
    const request = job.request as Record<string, unknown>
    const snapshot = task.snapshot as unknown as TaskSnapshot
    const model = snapshot.models.image
    const id = randomUUID()
    await tx.chetaidouCall.create({
      data: {
        id,
        taskId: task.id,
        rootTaskId: task.rootTaskId,
        ownerId: task.ownerId,
        targetKey: `image:${item.id}`,
        imageGenItemId: item.id,
        attempt: (pending?.attempt ?? 0) + 1,
        kind: "IMAGE",
        source: CHETAIDOU_USAGE_SOURCES.image,
        model: model.publicId,
        category: model.category,
        promptVersion: snapshot.generation?.generationPromptVersion
          ? `${snapshot.prompt?.version ?? CHETAIDOU_PROMPT_VERSION}:${snapshot.generation.generationPromptVersion}`
          : (snapshot.prompt?.version ?? CHETAIDOU_PROMPT_VERSION),
        request: {
          prompt: typeof request.prompt === "string" ? request.prompt : "",
          model: model.publicId,
          index: item.idx,
          generation: (task.snapshot as unknown as TaskSnapshot).generation ?? {},
          ...(snapshot.edit ? { edit: snapshot.edit, referenceFileKeys: request.referenceFileKeys, sourceFileKey: request.sourceFileKey } : {}),
        } as unknown as object,
        requestHash: stableHash({
          job: job.id,
          item: item.id,
          prompt: request.prompt,
          generation: (task.snapshot as unknown as TaskSnapshot).generation,
        }),
        providerIdempotencyKey: `${CHETAIDOU_CALL_PREFIX}${id}`,
        state: "PREPARED",
        billingStatus: "PENDING",
        estimatedSaleCny: "2.00000000",
      },
    })
    return { id, gatewayTaskId: null }
  }

  private async downloadArtifact(url: string): Promise<Buffer> {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 60_000,
      // 仅 HTTPS（Provider 侧已校验产物 URL 协议）
      validateStatus: s => s === 200,
    })
    return Buffer.from(response.data)
  }
}

/** 历史任务使用冻结质量；新任务不读质量环境变量。 */
function legacyQuality(raw?: string): Record<string, unknown> {
  if (!raw) return {}
  const value = raw.trim().toLowerCase() === "high" ? "hd" : raw.trim().toLowerCase()
  return { quality: value }
}

function readTerminal(task: ImageTask | null | undefined): ImageTask | null {
  if (!task) return null
  if (task.status === "queued" || task.status === "running") return null
  return task
}

function toDecimal(value: string): Decimal {
  return new Decimal(value)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

void CHETAIDOU_ERROR_CODES
