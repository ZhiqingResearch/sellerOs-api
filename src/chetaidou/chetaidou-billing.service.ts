// 车泰斗素材工作台 — 查账、定价与结算（方案 §8）
// 结算统一入口：文本按账单 × 模型倍率；图片一口价优先、否则按量。
// Decimal 全程字符串传递；零金额 FREE；负数/非法/非 CNY 进 REVIEW。
import { BadRequestException, Injectable, Logger } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import { safeMultiplier } from "../common/price-multiplier.util"
import { CREDIT_PER_CNY } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import {
  CHETAIDOU_CHARGE_PREFIX,
  CHETAIDOU_ERROR_CODES,
  CHETAIDOU_USAGE_SOURCES,
} from "./chetaidou.constants"

import { ChetaidouContextService, TaskSnapshot } from "./chetaidou-context.service"

export interface ChetaidouCallRow {
  id: string
  taskId: string
  rootTaskId: string
  ownerId: number
  kind: string // TEXT / IMAGE
  source: string
  model: string
  category: string | null
  targetKey: string
  groupId: string | null
  imageGenItemId: number | null
  billingStatus: string
  gatewayRequestId: string | null
  gatewayTaskId: string | null
  gatewayAmountCny: Decimal | null
  estimatedSaleCny: Decimal
  pricing: unknown
  usage: unknown
}

@Injectable()
export class ChetaidouBillingService {
  private readonly logger = new Logger(ChetaidouBillingService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayProvider,
    private readonly usage: UsageService,
    private readonly context: ChetaidouContextService
  ) {}

  /** 模型就绪检查（目录 enabled+gatewayActive；缺行 = MODEL_NOT_READY） */
  async assertModelsReady(frozen?: TaskSnapshot["models"]): Promise<TaskSnapshot["models"]> {
    return this.context.resolveModels(frozen)
  }

  /** 文本查账：有 requestId 才查；返回 null = 账单未出现（PENDING） */
  async lookupTextUsage(requestId: string): Promise<Decimal | null> {
    const record = await this.gateway.getUsageByRequestId(requestId)
    if (!record) return null
    if (record.amount === null) return null
    const amount = new Decimal(record.amount)
    if (!amount.isFinite() || amount.isNegative()) {
      // 非法金额走 REVIEW，不按 0 入账
      throw new BadRequestException({
        message: `网关账单金额异常：${record.amount}`,
        code: CHETAIDOU_ERROR_CODES.BILLING_PENDING,
      })
    }
    return amount
  }

  /** 待核对图片只查询原网关任务，不重新提交生成。 */
  async lookupImageUsage(taskId: string) {
    const task = await this.gateway.getImageTask(taskId)
    const usage = "usage" in task ? task.usage : undefined
    const amount = usage?.amount == null ? null : new Decimal(usage.amount)
    if (amount && (!amount.isFinite() || amount.isNegative())) {
      throw new BadRequestException("网关账单金额异常，请人工核对")
    }
    return { status: task.status, amount }
  }

  private async canSettleCall(
    tx: Prisma.TransactionClient,
    call: Prisma.ChetaidouCallGetPayload<Record<string, never>>
  ): Promise<boolean> {
    if (call.outcome === "ACCEPTED") return true
    // 明确失败优先，不能因为同时保留 UNKNOWN 状态就收费。
    if (call.outcome != null) return false
    if (call.state === "UNKNOWN") return true
    if (!call.submittedAt) return false
    const task = await tx.chetaidouTask.findUnique({
      where: { id: call.taskId },
      select: { status: true },
    })
    return task?.status === "WAITING_RECONCILIATION"
  }

  /**
   * 文本结算（调用方事务内）：锁 Call → 确认未结算 → 定价快照 → 扣费。
   * 账单 null 时保持 PENDING，定时查账，不记 0。
   */
  async settleTextInTx(
    tx: Prisma.TransactionClient,
    call: { id: string; model: string },
    gatewayAmountCny: Decimal | null
  ): Promise<"SETTLED" | "FREE" | "PENDING"> {
    const [locked] = await tx.$queryRaw<Prisma.ChetaidouCallGetPayload<Record<string, never>>[]>`
      SELECT * FROM ChetaidouCall WHERE id = ${call.id} FOR UPDATE
    `
    if (!locked) throw new Error(`Call 不存在：${call.id}`)
    if (locked.billingStatus === "SETTLED" || locked.billingStatus === "FREE") {
      return locked.billingStatus
    }
    // 成功及待核对调用均按实际账单结算，明确失败和正常执行中尚未校验的调用不扣费。
    if (!(await this.canSettleCall(tx, locked))) return "PENDING"
    if (gatewayAmountCny === null) {
      await tx.chetaidouCall.update({
        where: { id: call.id },
        data: {
          billingStatus: "PENDING",
        },
      })
      return "PENDING"
    }
    if (gatewayAmountCny.isZero()) {
      await tx.chetaidouCall.update({
        where: { id: call.id },
        data: { billingStatus: "FREE", gatewayAmountCny: "0", finishedAt: new Date() },
      })
      return "FREE"
    }
    const modelConfig = locked.category
      ? await tx.aiGatewayModel.findUnique({
          where: { publicId_category: { publicId: locked.model, category: locked.category } },
          select: { priceMultiplier: true },
        })
      : null
    const multiplier = locked.category
      ? safeMultiplier(modelConfig?.priceMultiplier)
      : await this.usage.gatewayPriceMultiplier(call.model)
    const saleCny = gatewayAmountCny.mul(multiplier)
    const pricing = {
      pricingMode: "metered",
      model: call.model,
      priceMultiplier: multiplier.toString(),
      gatewayAmountCny: gatewayAmountCny.toString(),
      pricedAt: new Date().toISOString(),
    }
    const result = await this.usage.chargeModelInTransaction(
      tx,
      locked.ownerId,
      saleCny.toString(),
      {
        source: locked.source satisfies string,
        model: call.model,
        requestId: `${CHETAIDOU_CHARGE_PREFIX}${call.id}`,
        allowOverdraft: true,
        meta: {
          callId: call.id,
          taskId: locked.taskId,
          rootTaskId: locked.rootTaskId,
          targetKey: locked.targetKey,
          gatewayRequestId: locked.gatewayRequestId ?? undefined,
          gatewayAmountCny: gatewayAmountCny.toString(),
          priceMultiplier: multiplier.toString(),
          pricingMode: "metered",
        },
      }
    )
    await tx.chetaidouCall.update({
      where: { id: call.id },
      data: {
        billingStatus: "SETTLED",
        gatewayAmountCny: gatewayAmountCny.toString(),
        pricing,
        chargedCredits: result.creditsCharged.toString(),
        finishedAt: new Date(),
      },
    })
    return "SETTLED"
  }

  /**
   * 图片结算（调用方事务内）：成功或待核对按一口价/网关账单 × 倍率结算。
   * 待核对必须先取得实际账单；失败或取消均不向用户扣费。
   * 返回结算状态；事务由调用方持有（锁顺序 Task→Job→Call→Item）。
   */
  async settleImageInTx(
    tx: Prisma.TransactionClient,
    call: {
      id: string
      taskId: string
      rootTaskId: string
      ownerId: number
      imageGenItemId: number | null
      model: string
    },
    gatewayAmountCny: Decimal | null,
    succeeded: boolean | "UNKNOWN"
  ): Promise<"SETTLED" | "FREE" | "PENDING"> {
    const [locked] = await tx.$queryRaw<Prisma.ChetaidouCallGetPayload<Record<string, never>>[]>`
      SELECT * FROM ChetaidouCall WHERE id = ${call.id} FOR UPDATE
    `
    if (!locked) throw new Error(`Call 不存在：${call.id}`)
    if (locked.billingStatus === "SETTLED" || locked.billingStatus === "FREE") {
      return locked.billingStatus
    }
    if (
      succeeded === "UNKNOWN" &&
      (gatewayAmountCny === null || !(await this.canSettleCall(tx, locked)))
    ) {
      return "PENDING"
    }
    if (!succeeded) {
      await tx.chetaidouCall.update({
        where: { id: call.id },
        data: {
          billingStatus: "FREE",
          chargedCredits: "0",
          ...(gatewayAmountCny ? { gatewayAmountCny: gatewayAmountCny.toString() } : {}),
          finishedAt: new Date(),
        },
      })
      return "FREE"
    }
    const baseMeta = {
      callId: call.id,
      taskId: call.taskId,
      rootTaskId: call.rootTaskId,
      imageGenItemId: call.imageGenItemId ?? undefined,
      gatewayTaskId: locked.gatewayTaskId ?? undefined,
    }
    // 已提交调用即使模型后来停用，仍按原分类目录定价，不能回落到新模型。
    if (!locked.category) throw new Error("生图调用缺少模型分类，无法结算")
    const modelRow = await tx.aiGatewayModel.findUnique({
      where: { publicId_category: { publicId: locked.model, category: locked.category } },
      select: { fixedCredits: true },
    })
    const fixedCredits = modelRow?.fixedCredits?.greaterThan(0) ? modelRow.fixedCredits : null
    if (fixedCredits) {
      const pricing = {
        pricingMode: "fixed",
        model: locked.model,
        fixedCredits: fixedCredits.toString(),
        pricedAt: new Date().toISOString(),
      }
      const result = await this.usage.chargeModelInTransaction(
        tx,
        call.ownerId,
        fixedCredits.div(CREDIT_PER_CNY).toString(),
        {
          source: CHETAIDOU_USAGE_SOURCES.image,
          model: locked.model,
          exactCredits: fixedCredits.toString(),
          requestId: `${CHETAIDOU_CHARGE_PREFIX}${call.id}`,
          allowOverdraft: true,
          meta: { ...baseMeta, pricingMode: "fixed", fixedCredits: fixedCredits.toString() },
        }
      )
      await tx.chetaidouCall.update({
        where: { id: call.id },
        data: {
          billingStatus: "SETTLED",
          pricing,
          chargedCredits: result.creditsCharged.toString(),
          finishedAt: new Date(),
        },
      })
      return "SETTLED"
    }
    // 按量
    if (gatewayAmountCny === null) {
      await tx.chetaidouCall.update({
        where: { id: call.id },
        data: { billingStatus: "PENDING" },
      })
      return "PENDING"
    }
    if (gatewayAmountCny.isZero()) {
      await tx.chetaidouCall.update({
        where: { id: call.id },
        data: { billingStatus: "FREE", gatewayAmountCny: "0", finishedAt: new Date() },
      })
      return "FREE"
    }
    const multiplier = await this.usage.gatewayPriceMultiplier(locked.model)
    const saleCny = gatewayAmountCny.mul(multiplier)
    const pricing = {
      pricingMode: "metered",
      model: locked.model,
      priceMultiplier: multiplier.toString(),
      gatewayAmountCny: gatewayAmountCny.toString(),
      pricedAt: new Date().toISOString(),
    }
    const result = await this.usage.chargeModelInTransaction(tx, call.ownerId, saleCny.toString(), {
      source: CHETAIDOU_USAGE_SOURCES.image,
      model: locked.model,
      requestId: `${CHETAIDOU_CHARGE_PREFIX}${call.id}`,
      allowOverdraft: true,
      meta: {
        ...baseMeta,
        pricingMode: "metered",
        gatewayAmountCny: gatewayAmountCny.toString(),
        priceMultiplier: multiplier.toString(),
      },
    })
    await tx.chetaidouCall.update({
      where: { id: call.id },
      data: {
        billingStatus: "SETTLED",
        gatewayAmountCny: gatewayAmountCny.toString(),
        pricing,
        chargedCredits: result.creditsCharged.toString(),
        finishedAt: new Date(),
      },
    })
    return "SETTLED"
  }
}
