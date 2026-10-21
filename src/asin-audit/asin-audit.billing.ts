import { Injectable, Logger } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import { randomUUID } from "node:crypto"
import { CREDIT_PER_CNY } from "../membership/membership.constants"
import { UsageService } from "../usage/usage.service"
import type { AsinAuditAction } from "./asin-audit.types"
import { PROMPT_VERSION } from "./prompts/prompt-assets"

/**
 * ASIN 审计共享计费（三个能力共用）：网关真实 CNY 账单 × 库表倍率 → chargeModel v2。
 * billingHandled 语义：后端已负责本次计费（含零金额结算）→ true，前端停止 Token 二次上报。
 */
@Injectable()
export class AsinAuditBilling {
  private readonly logger = new Logger(AsinAuditBilling.name)

  constructor(private readonly usage: UsageService) {}

  async charge(
    userId: number,
    model: string,
    action: AsinAuditAction,
    billing: { costCny: string; requestId: string; requestIds: string[] },
    clientRequestId?: string,
    opts?: { source?: string; meta?: Record<string, unknown> }
  ): Promise<boolean> {
    const costCny = new Decimal(billing.costCny)
    if (costCny.isZero()) {
      this.logger.log(
        `[asin-audit] zero-amount settled action=${action} model=${model} userId=${userId} requestId=${billing.requestId}`
      )
      return true
    }

    const multiplier = await this.usage.gatewayPriceMultiplier(model)
    const billed = costCny.mul(multiplier)
    await this.usage.chargeModel(userId, billed, {
      source: opts?.source ?? "asin.audit",
      model,
      requestId: billing.requestId,
      meta: {
        gatewayAmountCny: billing.costCny,
        priceMultiplier: multiplier.toString(),
        action,
        promptVersion: PROMPT_VERSION,
        gatewayRequestIds: billing.requestIds,
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(opts?.meta ?? {}),
      },
    })
    this.logger.log(
      `[asin-audit] charged action=${action} userId=${userId} model=${model} costCny=${billing.costCny} billed=${billed.toString()} requestId=${billing.requestId}`
    )
    return true
  }

  /**
   * 固定积分阶段扣费（2026-09 产品定价）：仅 ZQ-Think-Flash（Gemini-3.1-flash）
   * 适用一口价——取证模块 5 / 打分 20（含审计链取证成本）/ 优化 15；成功后扣
   * （调用点均在解析成功后），失败/解析失败不扣，免退款。
   * 非固定价模型返回 false，调用方回落按量 charge()。
   */
  async chargeFixedStage(
    userId: number,
    model: string,
    stage: AsinAuditFixedStage,
    extraMeta?: Record<string, unknown>,
    source: string = "asin.audit"
  ): Promise<boolean> {
    if (!isAsinAuditFixedModel(model)) return false
    const credits = ASIN_AUDIT_FIXED_CREDITS[stage]
    const requestId = `charge:asin-audit:${stage}:${randomUUID()}`
    await this.usage.chargeModel(userId, new Decimal(credits).div(CREDIT_PER_CNY), {
      source,
      model,
      exactCredits: credits,
      requestId,
      allowOverdraft: true,
      meta: {
        pricingMode: "fixed",
        stage,
        fixedCredits: credits,
        model,
        promptVersion: PROMPT_VERSION,
        ...(extraMeta ?? {}),
      },
    })
    this.logger.log(
      `[asin-audit] fixed-charged stage=${stage} userId=${userId} model=${model} credits=${credits} requestId=${requestId}`
    )
    return true
  }

  /**
   * 固定价余额预检：固定模型按阶段一口价校验（不足抛 400），返回是否命中固定价
   * （false = 非固定模型，调用方走按量口径、无需预检）。
   */
  async assertFixedStageAffordable(
    userId: number,
    model: string,
    stage: AsinAuditFixedStage
  ): Promise<boolean> {
    if (!isAsinAuditFixedModel(model)) return false
    await this.usage.assertExactCreditsAffordable(userId, ASIN_AUDIT_FIXED_CREDITS[stage])
    return true
  }
}

/** 固定一口价模型：仅 ZQ-Think-Flash（Gemini-3.1-flash）；其余模型保持按量计费 */
export const FIXED_CREDITS_MODEL = "ZQ-Think-Flash"

/**
 * 取证模块（scene=evidence-module）专用扣费 source：与审计打分/优化区分统计展示
 * （FeatureModule 注册表 label「ASIN 取证」）。按量回落路径同样使用。
 */
export const ASIN_EVIDENCE_SOURCE = "asin.audit.evidence"

export type AsinAuditFixedStage = "evidence" | "score" | "optimize"

/** 各阶段固定积分（成功后扣）：审计链（scene=audit）取证不扣，由打分 20 覆盖 */
export const ASIN_AUDIT_FIXED_CREDITS: Record<AsinAuditFixedStage, number> = {
  evidence: 5,
  score: 20,
  optimize: 15,
}

export function isAsinAuditFixedModel(model: string): boolean {
  return model === FIXED_CREDITS_MODEL
}
