import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import { randomUUID } from "node:crypto"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import { CREDIT_PER_CNY } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { ENHANCE_PROMPT_VERSION } from "./prompts/enhance-prompt"
import { IMAGE_INFERENCE_PROMPT_VERSION } from "./prompts/image-inference"
import { TRANSLATE_PROMPT_VERSION } from "./prompts/translate-prompt"

/**
 * AiGatewayModel 目录类别（建行见 scripts/onboard-llm-toolbox-models.ts）：
 * 每个类别**恰好一条启用行**（enabled + gatewayActive），换模型 = 建新行/启用新行并
 * 停用旧行，代码零改动（与 AI_SPLIT_MULTIMODAL 同款约定）。
 */
export const LLM_TOOLBOX_CATEGORY = "LLM_TOOLBOX" // 一键润色 / 中英互译（文本模型）
export const LLM_TOOLBOX_MULTIMODAL_CATEGORY = "LLM_TOOLBOX_MULTIMODAL" // 由图推理（多模态模型）

/** 计费 source：复用已注册的 llm.generic（P0 §1.3，勿新造枚举） */
const LLM_TOOLBOX_USAGE_SOURCE = "llm.generic"

/** 流水 meta.feature 的展示名（对齐前端现有流水口径，P0 §1.3） */
const TOOL_FEATURE_LABELS = {
  enhance: "一键润色",
  translate: "中英互译",
  "image-inference": "由图推理",
} as const

export type ToolboxTool = keyof typeof TOOL_FEATURE_LABELS

const TOOL_PROMPT_VERSIONS = {
  enhance: ENHANCE_PROMPT_VERSION,
  translate: TRANSLATE_PROMPT_VERSION,
  "image-inference": IMAGE_INFERENCE_PROMPT_VERSION,
} as const

/** 类目解析结果：模型 + 一口价（实时读库，改库即生效） */
export interface ToolboxModel {
  publicId: string
  category: string
  fixedCredits: Decimal | null
}

/**
 * 三件套模型解析与计费：一口价优先，未配置时按最终账单 × 类目倍率计费。
 * 扣费失败按 P0 现状降级：charge 返回 false 不抛错，响应 billingHandled:false。
 */
@Injectable()
export class LlmToolboxBilling {
  private readonly logger = new Logger(LlmToolboxBilling.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly gateway: AiGatewayProvider
  ) {}

  /**
   * 按类别解析启用模型；启用行数 ≠ 1 → 503。
   * fixedCredits 未配 / ≤0 → 按实际账单计费。
   */
  async resolveModel(category: string): Promise<ToolboxModel> {
    const rows = await this.prisma.aiGatewayModel.findMany({
      where: { category, enabled: true, gatewayActive: true },
      select: { publicId: true, fixedCredits: true },
      orderBy: { sortOrder: "asc" },
    })
    if (rows.length === 0) {
      throw new ServiceUnavailableException(
        `AiGatewayModel.${category} 无启用模型行，请先执行 scripts/onboard-llm-toolbox-models.ts 建行`
      )
    }
    if (rows.length > 1) {
      throw new ServiceUnavailableException(
        `AiGatewayModel.${category} 启用了 ${rows.length} 行（${rows.map(r => r.publicId).join("、")}），应恰好为 1——换模型请启用新行并停用旧行`
      )
    }
    const row = rows[0]
    const credits = row.fixedCredits ? new Decimal(row.fixedCredits) : null
    return {
      publicId: row.publicId,
      category,
      fixedCredits: credits?.greaterThan(0) ? credits : null,
    }
  }

  /** 成功后扣费（幂等键后端生成）；失败仅记日志返回 false（降级，不阻断结果返回） */
  async charge(
    userId: number,
    model: ToolboxModel,
    opts: { tool: ToolboxTool; gatewayRequestId: string }
  ): Promise<boolean> {
    try {
      const credits = model.fixedCredits
      let costCny: string
      let pricingMeta: Record<string, unknown>
      if (credits) {
        costCny = credits.div(CREDIT_PER_CNY).toString()
        pricingMeta = {
          pricingMode: "fixed",
          fixedCredits: credits.toString(),
          fixedPricing: "飞书《SellerOS积分 → 图片视频积分扣除》2026-09-20",
          credits: Number(credits.toString()),
        }
      } else {
        // 最终账单可能稍晚于回复落库，沿用网关计费的短轮询窗口，不使用估价。
        let amount: Decimal | null = null
        for (const delayMs of [0, 100, 250, 500, 1_000]) {
          if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
          const record = await this.gateway.getUsageByRequestId(opts.gatewayRequestId)
          if (record?.amount != null && !record.estimated) {
            amount = new Decimal(record.amount)
            break
          }
        }
        if (amount === null) throw new Error("AI Gateway 计费结果暂未就绪，无法完成积分结算")
        if (!amount.isFinite() || amount.lessThan(0))
          throw new Error("AI Gateway 返回的计费金额无效")
        if (amount.isZero()) return true
        const multiplier = await this.usage.gatewayPriceMultiplier(model.publicId, model.category)
        costCny = amount.mul(multiplier).toString()
        pricingMeta = {
          pricingMode: "metered",
          gatewayAmountCny: amount.toString(),
          priceMultiplier: multiplier.toString(),
        }
      }
      await this.usage.chargeModel(userId, costCny, {
        source: LLM_TOOLBOX_USAGE_SOURCE,
        model: model.publicId,
        ...(credits ? { exactCredits: credits.toString() } : {}),
        requestId: `toolbox:${opts.tool}:${randomUUID()}`,
        allowOverdraft: true,
        meta: {
          ...pricingMeta,
          feature: TOOL_FEATURE_LABELS[opts.tool],
          gatewayRequestId: opts.gatewayRequestId,
          promptVersion: TOOL_PROMPT_VERSIONS[opts.tool],
        },
      })
      return true
    } catch (err) {
      this.logger.error(
        `[llm-toolbox] 扣费失败（降级放行）：tool=${opts.tool} model=${model.publicId} message=${err instanceof Error ? err.message : String(err)}`
      )
      return false
    }
  }
}
