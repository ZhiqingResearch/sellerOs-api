import { BadGatewayException, Injectable, Logger } from "@nestjs/common"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { AsinAuditBilling } from "./asin-audit.billing"
import { asinAuditActionLabel } from "./asin-audit.types"
import type { ReviewCommentDto, ReviewPainPointsDto } from "./dto/review-pain-points.dto"
import { modelResponseLanguageDirective } from "./prompts/model-response-language"
import { buildReviewPainPointsSkill } from "./prompts/skill-assembler"
import { extractJson, parseLlmJson } from "./rules/extract-json"
import type { ReviewPainPoint } from "./types/audit.types"
import type { TokenUsage } from "./types/scout.types"

/** 单次送入模型的最大评论条数，避免超长 prompt。 */
const MAX_COMMENTS = 200
/** 单条评论截断长度，去除超长噪声。 */
const MAX_COMMENT_LEN = 600

function normalizeComments(list: ReviewCommentDto[]): ReviewCommentDto[] {
  return (Array.isArray(list) ? list : [])
    .map(c => ({
      // 爬虫 2026-09 起字段 name → customer，customer 优先、name 兼容旧前端
      name:
        typeof c?.customer === "string"
          ? c.customer
          : typeof c?.name === "string"
            ? c.name
            : undefined,
      comment: typeof c?.comment === "string" ? c.comment.trim() : "",
    }))
    .filter(c => c.comment)
    .map(c => ({
      name: c.name,
      comment: c.comment.length > MAX_COMMENT_LEN ? c.comment.slice(0, MAX_COMMENT_LEN) : c.comment,
    }))
}

function buildUserPrompt(input: ReviewPainPointsDto, comments: ReviewCommentDto[]): string {
  const payload = {
    review: {
      reviewCount: input.reviewCount ?? comments.length,
      star_percent: Array.isArray(input.starPercent) ? input.starPercent : [],
      comment_list: comments.map(c => ({ name: c.name, comment: c.comment })),
    },
  }
  return [
    "以下是某 ASIN 的评论数据（数据源 review 字段）。请严格按 skill 生成 Top 5 差评痛点。",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n")
}

function coercePainPoints(raw: unknown): ReviewPainPoint[] {
  const arr =
    raw && typeof raw === "object" && Array.isArray((raw as { painPoints?: unknown }).painPoints)
      ? (raw as { painPoints: unknown[] }).painPoints
      : Array.isArray(raw)
        ? (raw as unknown[])
        : []

  return arr
    .map((p): ReviewPainPoint | null => {
      if (!p || typeof p !== "object") return null
      const o = p as Record<string, unknown>
      const text = typeof o.text === "string" ? o.text.trim() : ""
      if (!text) return null
      const freqNum =
        typeof o.freq === "number"
          ? o.freq
          : typeof o.freq === "string"
            ? parseInt(o.freq, 10)
            : NaN
      return {
        text,
        freq: Number.isFinite(freqNum) && freqNum > 0 ? Math.round(freqNum) : undefined,
      }
    })
    .filter((p): p is ReviewPainPoint => !!p)
    .sort((a, b) => (b.freq ?? 0) - (a.freq ?? 0))
    .slice(0, 5)
}

export interface ReviewPainPointsOutcome {
  painPoints: ReviewPainPoint[]
  tokenUsage: TokenUsage | null
  /** 后端已负责本次计费（含零金额）；仅空评论未调模型时为 false */
  billingHandled: boolean
  /** 网关账单追踪号（未调模型时为 null） */
  requestId: string | null
}

/**
 * B 卡「评论痛点分析」（等价迁移 Web review-pain-points-service）：
 * 清洗 → 空评论直接返回（不调模型不扣费）→ 拼 prompt → 模型（temperature 0）→
 * extractJson/parseLlmJson → coercePainPoints（Top5 降序）→ 计费。
 * 非流式：控制器先跑完本服务再开 SSE；任何失败为开流前 HTTP 错误。
 */
@Injectable()
export class ReviewPainPointsService {
  private readonly logger = new Logger(ReviewPainPointsService.name)

  constructor(
    private readonly gateway: AiGatewayProvider,
    private readonly billing: AsinAuditBilling
  ) {}

  async run(
    dto: ReviewPainPointsDto,
    userId: number,
    opts?: { skipUsageCharge?: boolean }
  ): Promise<ReviewPainPointsOutcome> {
    const normalized = normalizeComments(dto.commentList)
    if (normalized.length === 0) {
      return { painPoints: [], tokenUsage: null, billingHandled: false, requestId: null }
    }

    const comments = normalized.slice(0, MAX_COMMENTS)
    if (normalized.length > MAX_COMMENTS) {
      this.logger.warn(
        `[asin-audit/pain-points] comment_list 超过 ${MAX_COMMENTS} 条，仅取前 ${MAX_COMMENTS} 条送模型（共 ${normalized.length} 条）`
      )
    }

    const systemPrompt = `${buildReviewPainPointsSkill()}\n\n${modelResponseLanguageDirective(dto.responseLanguage ?? "zh-CN")}`
    const userPrompt = buildUserPrompt(dto, comments)

    let textBuffer = ""
    let tokenUsage: TokenUsage | null = null
    let billing: { costCny: string; requestId: string; requestIds: string[] } | undefined
    for await (const event of this.gateway.streamChat(systemPrompt, userPrompt, {
      model: dto.model,
      temperature: 0,
      operationName: `ASIN 审计${asinAuditActionLabel("review-pain-points")}`,
      resolveBilling: true,
    })) {
      if (event.type === "text") {
        textBuffer += event.content
        continue
      }
      if (event.type === "usage" && event.usage) {
        tokenUsage = event.usage
        continue
      }
      if (event.type === "billing" && event.billing) {
        billing = event.billing
      }
    }
    if (!billing) {
      throw new BadGatewayException("AI Gateway 计费结果暂未就绪，无法完成积分结算")
    }

    // 先解析后计费：解析失败不扣分（与 Web 前端「成功才上报 usage」口径一致）
    const jsonStr = extractJson(textBuffer)
    if (!jsonStr) throw new Error("评论痛点分析：未从模型响应中解析出 JSON")
    const painPoints = coercePainPoints(parseLlmJson(jsonStr))

    // 固定价模型的取证内嵌调用不按量扣费（审计链免费 / 取证模块由流程价 5 覆盖）；
    // 独立路由（/review-pain-points）不传 skipUsageCharge，维持按量计费
    const billed = opts?.skipUsageCharge
      ? true
      : await this.billing.charge(
          userId,
          dto.model,
          "review-pain-points",
          billing,
          dto.clientRequestId
        )
    this.logger.log(
      `[asin-audit] pain-points finalized userId=${userId} model=${dto.model} count=${painPoints.length}`
    )
    return { painPoints, tokenUsage, billingHandled: billed, requestId: billing.requestId }
  }
}
