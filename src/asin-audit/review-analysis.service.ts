import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import * as XLSX from "xlsx"
import type { Country } from "../audit/audit.marketplace"
import { AuditService } from "../audit/audit.service"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { AsinAuditBilling } from "./asin-audit.billing"
import { asinAuditActionLabel } from "./asin-audit.types"
import type { ReviewDownloadDto } from "./dto/review-download.dto"
import type { ReviewCommentDto, ReviewPainPointsDto } from "./dto/review-pain-points.dto"
import { REVIEW_DOWNLOAD_COLUMNS, extractReviewRows } from "./evidence/adapt-audit-detail"
import { modelResponseLanguageDirective } from "./prompts/model-response-language"
import { buildReviewAnalysisSkill } from "./prompts/skill-assembler"
import { extractJson, parseLlmJson } from "./rules/extract-json"
import type { AuditDetailResponse, ReviewHighlight, ReviewPainPoint } from "./types/audit.types"
import type { TokenUsage } from "./types/scout.types"

/** 单次送入模型的最大评论条数，避免超长 prompt（与痛点分析同口径）。 */
const MAX_COMMENTS = 200
/** 单条评论截断长度，去除超长噪声。 */
const MAX_COMMENT_LEN = 600
/** quote 原文摘录长度上限。 */
const MAX_QUOTE_LEN = 200

interface ReviewComment {
  name?: string
  comment: string
}

function normalizeComments(list: ReviewCommentDto[]): ReviewComment[] {
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

function buildUserPrompt(input: ReviewPainPointsDto, comments: ReviewComment[]): string {
  const payload = {
    review: {
      reviewCount: input.reviewCount ?? comments.length,
      star_percent: Array.isArray(input.starPercent) ? input.starPercent : [],
      comment_list: comments.map(c => ({ name: c.name, comment: c.comment })),
    },
  }
  return [
    "以下是某 ASIN 的评论数据（数据源 review 字段）。请严格按 skill 生成 Top 5 好评亮点与 Top 5 差评痛点。",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n")
}

/** quote 防幻觉：归一化（小写 + 压空白）后必须是评论原文的子串。 */
function quoteLooksVerbatim(quote: string, comments: ReviewComment[]): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim()
  const haystack = norm(comments.map(c => c.comment).join(" \n "))
  return haystack.includes(norm(quote))
}

/** 双数组归一：空 text 过滤、freq 正整数取整、quote 逐字校验失败即丢；各按 freq 降序 Top5。 */
function coerceInsights(
  raw: unknown,
  key: "highlights" | "painPoints",
  comments: ReviewComment[]
): (ReviewHighlight | ReviewPainPoint)[] {
  const container = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const arr = Array.isArray(container[key]) ? (container[key] as unknown[]) : []

  return arr
    .map((p): ReviewHighlight | null => {
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
      const quote = typeof o.quote === "string" ? o.quote.trim() : ""
      const quoteOk =
        !!quote && quote.length <= MAX_QUOTE_LEN && quoteLooksVerbatim(quote, comments)
      return {
        text,
        freq: Number.isFinite(freqNum) && freqNum > 0 ? Math.round(freqNum) : undefined,
        ...(quoteOk ? { quote } : {}),
      }
    })
    .filter((p): p is ReviewHighlight => !!p)
    .sort((a, b) => (b.freq ?? 0) - (a.freq ?? 0))
    .slice(0, 5)
}

export interface ReviewAnalysisOutcome {
  highlights: ReviewHighlight[]
  painPoints: ReviewPainPoint[]
  tokenUsage: TokenUsage | null
  /** 后端已负责本次计费（含零金额）；仅空评论未调模型时为 false */
  billingHandled: boolean
  /** 网关账单追踪号（未调模型时为 null） */
  requestId: string | null
}

/** 下载文件各列宽度（wch：字符数），评论正文/标题拉宽保证可读。 */
const REVIEW_DOWNLOAD_COL_WIDTHS = [20, 16, 8, 40, 80, 12, 10, 24]

export interface ReviewDownloadFile {
  buffer: Buffer
  /** Content-Disposition 的 UTF-8 文件名（原始评论-ASIN-日期.xlsx） */
  utf8Filename: string
  /** Content-Disposition 的 ASCII 兜底文件名（reviews-ASIN-日期.xlsx） */
  asciiFilename: string
  /** 导出的评论条数 */
  count: number
}

/**
 * B 卡「评论分析」双输出（好评亮点 + 差评痛点，取证模块 type=module 专用）：
 * 与 ReviewPainPointsService 并存的新链路——清洗 → 空评论直接返回（不调模型不扣费）→
 * 拼 prompt（同载荷）→ 模型（temperature 0）→ extractJson/parseLlmJson →
 * coerceInsights（双数组 Top5 + quote 逐字校验）→ 计费。
 * 非流式；任何失败由调用方（evidence 编排）降级为基础 B 卡。
 */
@Injectable()
export class ReviewAnalysisService {
  private readonly logger = new Logger(ReviewAnalysisService.name)

  constructor(
    private readonly gateway: AiGatewayProvider,
    private readonly billing: AsinAuditBilling,
    private readonly audit: AuditService
  ) {}

  async run(
    dto: ReviewPainPointsDto,
    userId: number,
    opts?: { skipUsageCharge?: boolean; source?: string; meta?: Record<string, unknown> }
  ): Promise<ReviewAnalysisOutcome> {
    const normalized = normalizeComments(dto.commentList)
    if (normalized.length === 0) {
      return {
        highlights: [],
        painPoints: [],
        tokenUsage: null,
        billingHandled: false,
        requestId: null,
      }
    }

    const comments = normalized.slice(0, MAX_COMMENTS)
    if (normalized.length > MAX_COMMENTS) {
      this.logger.warn(
        `[asin-audit/review-analysis] comment_list 超过 ${MAX_COMMENTS} 条，仅取前 ${MAX_COMMENTS} 条送模型（共 ${normalized.length} 条）`
      )
    }

    const systemPrompt = `${buildReviewAnalysisSkill()}\n\n${modelResponseLanguageDirective(dto.responseLanguage ?? "zh-CN")}`
    const userPrompt = buildUserPrompt(dto, comments)

    let textBuffer = ""
    let tokenUsage: TokenUsage | null = null
    let billing: { costCny: string; requestId: string; requestIds: string[] } | undefined
    for await (const event of this.gateway.streamChat(systemPrompt, userPrompt, {
      model: dto.model,
      temperature: 0,
      operationName: `ASIN 审计${asinAuditActionLabel("review-analysis")}`,
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

    // 先解析后计费：解析失败不扣分（与痛点分析同口径）
    const jsonStr = extractJson(textBuffer)
    if (!jsonStr) throw new Error("评论分析：未从模型响应中解析出 JSON")
    const parsed = parseLlmJson<unknown>(jsonStr)
    const highlights = coerceInsights(parsed, "highlights", comments)
    const painPoints = coerceInsights(parsed, "painPoints", comments)

    // 固定价模型的取证内嵌调用不按量扣费（取证模块由流程价 5 覆盖）；
    // 其余调用方不传 skipUsageCharge，维持按量计费；source/meta 供取证场景按量回落分流
    const billed = opts?.skipUsageCharge
      ? true
      : await this.billing.charge(
          userId,
          dto.model,
          "review-analysis",
          billing,
          dto.clientRequestId,
          { source: opts?.source, meta: opts?.meta }
        )
    this.logger.log(
      `[asin-audit] review-analysis finalized userId=${userId} model=${dto.model} highlights=${highlights.length} painPoints=${painPoints.length}`
    )
    return {
      highlights,
      painPoints,
      tokenUsage,
      billingHandled: billed,
      requestId: billing.requestId,
    }
  }

  /**
   * 下载原始评论（B 卡评论分析数据源导出）：读 AuditProduct 缓存（原爬虫 30 天/Apify 1 小时，未命中重新抓取）→
   * 提取 review.comment_list 8 列 → 生成 xlsx buffer。
   * 纯读取不扣积分；评论列表为空 404（爬虫侧该字段可能整体缺失）。
   */
  async downloadRawReviews(dto: ReviewDownloadDto): Promise<ReviewDownloadFile> {
    const asin = dto.asin?.trim() || undefined
    const url = dto.productUrl?.trim() || undefined
    if (!asin && !url) throw new BadRequestException("asin 与 productUrl 二选一")

    // 都传以 asin 为准（与取证接口同口径）；findDetail 缓存未命中才调爬虫，爬虫失败 502 原生抛出
    const row = await this.audit.findDetail({
      ...(asin ? { asin } : { url: url! }),
      country: (dto.country ?? "US") as Country,
    })
    const resp: AuditDetailResponse = {
      id: row.id,
      url: row.url,
      platform: row.platform,
      country: row.country,
      asin: row.asin,
      name: row.name,
      data: row.data as Record<string, unknown> | null,
      fetchedAt: row.fetchedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }

    const rows = extractReviewRows(resp)
    if (rows.length === 0) {
      throw new NotFoundException("本次商品数据未获取原始评论，暂无法下载")
    }

    const sheet = XLSX.utils.aoa_to_sheet([REVIEW_DOWNLOAD_COLUMNS.map(c => c.header), ...rows])
    sheet["!cols"] = REVIEW_DOWNLOAD_COL_WIDTHS.map(wch => ({ wch }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, sheet, "原始评论")
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer

    // 文件名里的 ASIN 做非字母数字清洗（防 Content-Disposition header 注入）；仅传 url 时回落 row.asin
    const asinSlug =
      (asin ?? row.asin ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "reviews"
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date())
    this.logger.log(`[asin-audit] review download asin=${asinSlug} rows=${rows.length}`)
    return {
      buffer,
      utf8Filename: `原始评论-${asinSlug}-${date}.xlsx`,
      asciiFilename: `reviews-${asinSlug}-${date}.xlsx`,
      count: rows.length,
    }
  }
}
