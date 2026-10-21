// 车泰斗素材工作台 — 维护端服务（方案 §5.3/§7.6）
// 资料发布（facts/预置母版/固定拆解）、SKU 启停、异常调用核对。
// 不提供新增 SKU；confirmedBy 取登录人，不收前端姓名。
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { randomUUID } from "crypto"
import { PrismaService } from "../prisma/prisma.service"
import { ChetaidouContextService } from "./chetaidou-context.service"
import { ChetaidouStorageService, stableHash } from "./chetaidou-storage.service"
import { CHETAIDOU_BUSINESS_TYPE } from "./chetaidou.constants"
import { validateBreakdownOutput } from "./chetaidou.schemas"
import { ChetaidouService } from "./chetaidou.service"

@Injectable()
export class ChetaidouAdminService {
  private readonly logger = new Logger(ChetaidouAdminService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ChetaidouStorageService,
    private readonly context: ChetaidouContextService,
    private readonly chetaidou: ChetaidouService
  ) {}

  async getStatus() {
    const [skus, unknownCalls, reviewCalls, pendingBills, deliveryPending] = await Promise.all([
      this.prisma.chetaidouSku.findMany({ orderBy: { id: "asc" } }),
      this.prisma.chetaidouCall.count({ where: { state: "UNKNOWN" } }),
      this.prisma.chetaidouCall.count({ where: { billingStatus: "REVIEW" } }),
      this.prisma.chetaidouCall.count({
        where: { billingStatus: "PENDING", state: { in: ["RECEIVED", "FINISHED"] } },
      }),
      this.prisma.imageGenItem.count({
        where: { status: "DELIVERY_PENDING", job: { businessType: CHETAIDOU_BUSINESS_TYPE } },
      }),
    ])
    return {
      skus: skus.map(s => ({
        id: s.id,
        code: s.code,
        name: s.name,
        enabled: s.enabled,
        currentFactId: s.currentFactId,
        revision: s.revision,
      })),
      calls: { unknown: unknownCalls, review: reviewCalls, pendingBills, deliveryPending },
    }
  }

  async patchSku(skuId: number, dto: { revision: number; enabled?: boolean; name?: string }) {
    const updated = await this.prisma.chetaidouSku.updateMany({
      where: { id: skuId, revision: dto.revision },
      data: {
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.name ? { name: dto.name } : {}),
        revision: { increment: 1 },
      },
    })
    if (updated.count === 0) throw new ConflictException("SKU revision 不匹配")
    return this.prisma.chetaidouSku.findUnique({ where: { id: skuId } })
  }

  async listFacts(skuId: number) {
    return this.prisma.chetaidouFactCard.findMany({
      where: { skuId },
      orderBy: { version: "desc" },
    })
  }

  /** 发布 facts 版本：锁 SKU 行分配版本并更新指针（只追加） */
  async publishFact(
    skuId: number,
    actorId: number,
    dto: { expectedRevision: number; content: unknown }
  ) {
    const contentHash = stableHash(dto.content)
    return this.prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM ChetaidouSku WHERE id = ${skuId} FOR UPDATE`
        const sku = await tx.chetaidouSku.findUnique({ where: { id: skuId } })
        if (!sku) throw new NotFoundException("SKU 不存在")
        if (sku.revision !== dto.expectedRevision) {
          throw new ConflictException("SKU revision 不匹配，请刷新后重试")
        }
        const version = (await tx.chetaidouFactCard.count({ where: { skuId } })) + 1
        const fact = await tx.chetaidouFactCard.create({
          data: {
            skuId,
            version,
            content: dto.content as object,
            contentHash,
            confirmedBy: actorId,
            confirmedAt: new Date(),
          },
        })
        await tx.chetaidouSku.update({
          where: { id: skuId },
          data: { currentFactId: fact.id },
        })
        return fact
      },
      { timeout: 15_000 }
    )
  }

  /** 预置母版导入（multipart 私有上传；25MiB 限额） */
  async importPresetImage(
    skuId: number,
    actorId: number,
    file: { buffer: Buffer },
    dto: { title: string; number?: string; importKey?: string }
  ) {
    const sku = await this.prisma.chetaidouSku.findUnique({ where: { id: skuId } })
    if (!sku) throw new NotFoundException("SKU 不存在")
    if (!sku.currentFactId) throw new BadRequestException("请先发布事实卡")
    if (dto.importKey) {
      const existing = await this.prisma.chetaidouImage.findUnique({
        where: { importKey: dto.importKey },
      })
      if (existing) {
        if (existing.checksum !== "") {
          // 同键幂等复用（checksum 由调用方保证一致；内容冲突显式报错）
          return { imageId: existing.id, reused: true }
        }
      }
    }
    const asset = await this.storage.validateImage(file.buffer)
    if (dto.importKey) {
      const existing = await this.prisma.chetaidouImage.findUnique({
        where: { importKey: dto.importKey },
      })
      if (existing) {
        if (existing.checksum === asset.checksum) return { imageId: existing.id, reused: true }
        throw new ConflictException("importKey 已绑定不同内容的图片，请使用新 importKey 导入新版本")
      }
    }
    const fileKey = this.storage.masterFileKey(skuId, "preset", randomUUID())
    const thumbnailKey = await this.storage.uploadMaster(asset, fileKey)
    try {
      const image = await this.prisma.chetaidouImage.create({
        data: {
          skuId,
          sourceType: "PRESET",
          ownerId: null,
          createdBy: actorId,
          title: dto.title,
          number: dto.number,
          fileKey,
          mime: asset.mime,
          width: asset.width,
          height: asset.height,
          checksum: asset.checksum,
          sourceMetadata: thumbnailKey ? { thumbnailKey } : undefined,
          importKey: dto.importKey,
        },
      })
      return { imageId: image.id, reused: false }
    } catch (error) {
      await this.storage.deleteObject(fileKey).catch(() => undefined)
      if (thumbnailKey) await this.storage.deleteObject(thumbnailKey).catch(() => undefined)
      throw error
    }
  }

  /** 导入固定拆解 JSON（追加版本；CONFIRMED 仅经人工发布） */
  async importBreakdown(
    imageId: number,
    actorId: number,
    dto: { payload: unknown; importKey?: string }
  ) {
    const image = await this.prisma.chetaidouImage.findUnique({ where: { id: imageId } })
    if (!image) throw new NotFoundException("母版不存在")
    const sku = await this.prisma.chetaidouSku.findUnique({ where: { id: image.skuId } })
    if (!sku?.currentFactId) throw new BadRequestException("SKU 未发布事实卡")
    let payload
    try {
      payload = validateBreakdownOutput(dto.payload)
    } catch (error) {
      throw new BadRequestException(
        `拆解 JSON 不符合 Schema：${error instanceof Error ? error.message : String(error)}`
      )
    }
    const contentHash = stableHash(payload)
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ChetaidouImage WHERE id = ${imageId} FOR UPDATE`
      const version = (await tx.chetaidouBreakdown.count({ where: { imageId } })) + 1
      const created = await tx.chetaidouBreakdown.create({
        data: {
          imageId,
          version,
          factId: sku.currentFactId!,
          source: "PRESET",
          qualityStatus: "CONFIRMED",
          payload: payload as unknown as object,
          schemaVersion: 1,
          contentHash,
          confirmedBy: actorId,
          confirmedAt: new Date(),
          importKey: dto.importKey,
        },
      })
      await tx.chetaidouImage.update({
        where: { id: imageId },
        data: { currentBreakdownId: created.id },
      })
      return { breakdownId: created.id, version: created.version }
    })
  }

  /** 触发 AI 重新拆解（不能自动 CONFIRMED） */
  async rebreak(imageId: number, actorId: number, idempotencyKey: string) {
    const image = await this.prisma.chetaidouImage.findUnique({ where: { id: imageId } })
    if (!image) throw new NotFoundException("母版不存在")
    const sku = await this.prisma.chetaidouSku.findUnique({ where: { id: image.skuId } })
    if (!sku?.currentFactId) throw new BadRequestException("SKU 未发布事实卡")
    if (image.activeBreakdownTaskId) {
      const active = await this.prisma.chetaidouTask.findUnique({
        where: { id: image.activeBreakdownTaskId },
      })
      if (active && ["QUEUED", "RUNNING", "WAITING_RECONCILIATION"].includes(active.status ?? "")) {
        throw new ConflictException("已有拆解任务进行中")
      }
    }
    const requestHash = this.context.requestHash({ action: "rebreak", imageId })
    const existing = await this.prisma.chetaidouTask.findFirst({
      where: { ownerId: actorId, idempotencyKey },
    })
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException("幂等键已用于不同请求")
      }
      return { taskId: existing.id }
    }
    const fact = await this.prisma.chetaidouFactCard.findUnique({
      where: { id: sku.currentFactId },
    })
    const snapshot = await this.context.buildSnapshot({
      image: {
        id: image.id,
        skuId: image.skuId,
        fileKey: image.fileKey,
        checksum: image.checksum,
        width: image.width,
        height: image.height,
        mime: image.mime,
      },
      fact: {
        id: fact!.id,
        version: fact!.version,
        content: fact!.content,
        contentHash: fact!.contentHash,
      },
      breakdown: null,
      models: await this.context.resolveBreakdownModels(),
      settings: {
        site: "original",
        textMode: "keep",
        personMode: "keep",
        personText: "",
        customText: "",
      },
      resolvedSelections: [],
      customDimensions: [],
      decisions: [],
    })
    const taskId = randomUUID()
    await this.prisma.$transaction(async tx => {
      await tx.chetaidouTask.create({
        data: {
          id: taskId,
          rootTaskId: taskId,
          ownerId: actorId,
          skuId: image.skuId,
          imageId,
          type: "BREAKDOWN",
          status: "QUEUED",
          stage: "排队中",
          idempotencyKey,
          requestHash,
          contextHash: this.context.contextHash("ideation", snapshot),
          snapshot: snapshot as unknown as object,
          input: { action: "rebreak" },
        },
      })
      const claimed = await tx.chetaidouImage.updateMany({
        where: { id: imageId, activeBreakdownTaskId: image.activeBreakdownTaskId },
        data: { activeBreakdownTaskId: taskId },
      })
      if (claimed.count === 0) throw new ConflictException("该图已有新的拆解任务，请勿重复提交")
    })
    return { taskId }
  }

  /** 人工确认 AI 稿 → 追加 PRESET/CONFIRMED 版本（不篡改原 AI 行） */
  async publishBreakdown(imageId: number, breakdownId: number, actorId: number) {
    const source = await this.prisma.chetaidouBreakdown.findUnique({
      where: { id: breakdownId },
    })
    if (!source || source.imageId !== imageId) throw new NotFoundException("拆解不存在")
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ChetaidouImage WHERE id = ${imageId} FOR UPDATE`
      const version = (await tx.chetaidouBreakdown.count({ where: { imageId } })) + 1
      const created = await tx.chetaidouBreakdown.create({
        data: {
          imageId,
          version,
          factId: source.factId,
          source: "PRESET",
          qualityStatus: "CONFIRMED",
          payload: source.payload as unknown as object,
          schemaVersion: source.schemaVersion,
          contentHash: source.contentHash,
          confirmedBy: actorId,
          confirmedAt: new Date(),
          sourceMetadata: { publishedFromBreakdownId: source.id },
        },
      })
      await tx.chetaidouImage.update({
        where: { id: imageId },
        data: { currentBreakdownId: created.id },
      })
      return { breakdownId: created.id, version: created.version }
    })
  }

  /** 异常调用列表（UNKNOWN/REVIEW/待结算/待转存过滤） */
  async listCalls(query: { filter?: string; page: number; pageSize: number }) {
    const where: Prisma.ChetaidouCallWhereInput = (() => {
      switch (query.filter) {
        case "UNKNOWN":
          return { state: "UNKNOWN" }
        case "REVIEW":
          return { billingStatus: "REVIEW" }
        case "PENDING":
          return { billingStatus: "PENDING" }
        case "DELIVERY":
          return { outcome: "DELIVERY_FAILED" }
        default:
          return {
            OR: [{ state: "UNKNOWN" }, { billingStatus: { in: ["REVIEW", "PENDING"] } }],
          }
      }
    })()
    const [total, rows] = await Promise.all([
      this.prisma.chetaidouCall.count({ where }),
      this.prisma.chetaidouCall.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          taskId: true,
          rootTaskId: true,
          targetKey: true,
          kind: true,
          source: true,
          model: true,
          state: true,
          outcome: true,
          billingStatus: true,
          gatewayTaskId: true,
          gatewayRequestId: true,
          gatewayAmountCny: true,
          chargedCredits: true,
          errorCode: true,
          errorMessage: true,
          submittedAt: true,
          receivedAt: true,
          finishedAt: true,
          updatedAt: true,
        },
      }),
    ])
    return { total, page: query.page, pageSize: query.pageSize, items: rows }
  }

  /** 单个调用核对（只查询，不创建收费请求） */
  async reconcileCall(
    callId: string,
    runner: {
      lookupTextUsage: (requestId: string) => Promise<unknown>
    }
  ) {
    const call = await this.prisma.chetaidouCall.findUnique({ where: { id: callId } })
    if (!call) throw new NotFoundException("调用不存在")
    const result: Record<string, unknown> = { id: callId, state: call.state }
    if (call.kind === "TEXT" && call.gatewayRequestId) {
      const usage = await runner.lookupTextUsage(call.gatewayRequestId).catch(err => ({
        error: err instanceof Error ? err.message : String(err),
      }))
      result.usage = usage
    }
    if (call.kind === "IMAGE" && call.gatewayTaskId) {
      result.note = "图片任务请通过网关任务查询接口核对 gatewayTaskId"
      result.gatewayTaskId = call.gatewayTaskId
    }
    return result
  }

  /** 人工核对落账：绑定证据或登记未受理；不直接提交金额/积分/成功图片 */
  async resolveCall(
    callId: number | string,
    actorId: number,
    dto: { conclusion: string; evidence?: string; note?: string }
  ) {
    const call = await this.prisma.chetaidouCall.findUnique({ where: { id: String(callId) } })
    if (!call) throw new NotFoundException("调用不存在")
    const updated = await this.prisma.chetaidouCall.update({
      where: { id: String(callId) },
      data: {
        resolution: {
          conclusion: dto.conclusion,
          evidence: dto.evidence,
          note: dto.note,
          resolvedBy: actorId,
          resolvedAt: new Date().toISOString(),
        },
        ...(dto.conclusion === "NOT_ACCEPTED_NO_FEE"
          ? { state: "FINISHED", outcome: "CANCELLED", billingStatus: "FREE" }
          : {}),
        ...(dto.conclusion === "CONFIRMED_FEE" ? { state: "FINISHED" } : {}),
      },
    })
    void this.chetaidou
    return { id: updated.id, state: updated.state, billingStatus: updated.billingStatus }
  }
}
