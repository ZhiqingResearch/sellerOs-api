import { BadRequestException, Injectable, Logger } from "@nestjs/common"
import { auditDataSource } from "../../audit/audit-data"
import { parseAmazonAuditTarget, type Country } from "../../audit/audit.marketplace"
import { AuditService } from "../../audit/audit.service"
import {
  ASIN_EVIDENCE_SOURCE,
  AsinAuditBilling,
  isAsinAuditFixedModel,
} from "../asin-audit.billing"
import { EvidenceRequestDto } from "../dto/evidence.dto"
import type { ReviewPainPointsDto } from "../dto/review-pain-points.dto"
import { ReviewAnalysisService } from "../review-analysis.service"
import { ReviewPainPointsService } from "../review-pain-points.service"
import { filterCompetitorCandidates } from "../rules/competitor-filter"
import { computeBsrTrendPrecompute } from "../rules/traffic-precompute"
import type {
  AuditDetailResponse,
  AuditEvidence,
  DeEvidenceResult,
  ListingEvidence,
  ProductParamsEvidence,
  ReviewEvidence,
} from "../types/audit.types"
import type { Market } from "../types/scout.types"
import { adaptAuditDetail, extractReviewComments } from "./adapt-audit-detail"
import { adaptAsinPerformanceE, adaptCompetitorC, adaptKeywordTrafficD } from "./adapters"
import { SellerSpriteMcpClient } from "./mcp.client"
import { SifApiError, SifClient } from "./sif.client"

const ASIN_RE = /^[A-Z0-9]{10}$/

export type EvidenceCard = "A" | "P" | "B" | "C" | "D" | "E"

export type EvidenceSseEvent =
  | { type: "progress"; card: EvidenceCard; message: string }
  | { type: "warning"; message: string }
  | { type: "evidence"; card: EvidenceCard; data: unknown }
  | { type: "done"; result: AuditEvidence; checklist: EvidenceChecklist }
  | { type: "error"; message: string; code?: number }

/** 页面 8 项取证清单（对应前端 AuditEvidenceChecklist；逐项 status/source/missingReason） */
export interface EvidenceChecklistItem {
  status: "fetched" | "missing" | "skipped"
  source?: "crawler" | "apify" | "sif" | "mcp" | "ai"
  missingReason?: string
  fetchedAt?: string
  /** 仅 reviews 项：痛点模型是否已产出 */
  hasPainPoints?: boolean
  /** 仅 module 模式 reviews 项：亮点是否已产出 */
  hasHighlights?: boolean
  /** 仅 reviews 项：评论统计与正文分别表示 */
  hasReviewText?: boolean
  reviewTextMissingReason?: string
  /** 仅 skipped 项：说明 */
  note?: string
}

export interface EvidenceChecklist {
  listing: EvidenceChecklistItem // 当前 Listing 内容：A.filled 且 title 非空
  qa: EvidenceChecklistItem // Q&A：A.qa 非空数组
  aplus: EvidenceChecklistItem // A+：模块或图片非空，或 hasAplus=true
  images: EvidenceChecklistItem // 主副图：A.productImages 非空数组
  params: EvidenceChecklistItem // 参数信息：P.filled
  reviews: EvidenceChecklistItem // 评论分析：B.filled（评分或评论数）
  traffic: EvidenceChecklistItem // 关键词与流量：D.filled
  ads: EvidenceChecklistItem // 广告数据：上传链路，本接口不包含
}

export function normalizeAsin(input: string): string {
  const trimmed = input.trim().toUpperCase()
  if (!ASIN_RE.test(trimmed)) {
    throw new BadRequestException("ASIN 格式无效（需 10 位字母数字）")
  }
  return trimmed
}

const COUNTRY_MARKET: Record<string, Market> = {
  US: "amazon_us",
  UK: "amazon_uk",
  DE: "amazon_de",
}

function trendDateRange(): { startDate: string; endDate: string } {
  const end = new Date()
  const start = new Date(end.getTime() - 30 * 86_400_000)
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  }
}

/**
 * ASIN 审计取证编排（合成版：一次返回六卡）。
 * - 爬虫路（A/P/B）：复用 AuditService（audit/detail 同源爬虫/Apify 兜底 + 分来源缓存）→ adaptAuditDetail；
 *   失败只 warning 降级为空卡，不中断。
 * - SIF 路（D→C→E）：等价迁移 fetch-de-evidence；我方关键词主请求失败 = 整体失败（流内 error）。
 * - B 卡 AI 痛点：评论非空时串行调 ReviewPainPointsService（含计费）补 richPainPoints；失败回退基础卡。
 * - estimatedPoints 仅估值落字段（SIF 口径），不用于扣费。
 */
@Injectable()
export class EvidenceService {
  private readonly logger = new Logger(EvidenceService.name)

  constructor(
    private readonly sif: SifClient,
    private readonly mcp: SellerSpriteMcpClient,
    private readonly audit: AuditService,
    private readonly billing: AsinAuditBilling,
    private readonly painPoints: ReviewPainPointsService,
    private readonly reviewAnalysis: ReviewAnalysisService
  ) {}

  /** 开流前校验：解析 asin 与 country（400），返回归一值 */
  resolve(dto: EvidenceRequestDto): { asin: string; country: string; productUrl: string | null } {
    const rawAsin = dto.asin?.trim()
    const rawUrl = dto.productUrl?.trim()
    if (rawUrl) {
      const target = parseAmazonAuditTarget(rawUrl)
      if (!target) throw new BadRequestException("请提供 US、UK 或 DE 站点的 Amazon 商品详情地址")
      if (rawAsin && normalizeAsin(rawAsin) !== target.asin) {
        throw new BadRequestException("ASIN 与商品地址不一致")
      }
      if (dto.country && dto.country !== String(target.country)) {
        throw new BadRequestException("所选站点与商品地址不一致")
      }
      return { asin: target.asin, country: target.country, productUrl: rawUrl }
    }
    if (rawAsin)
      return { asin: normalizeAsin(rawAsin), country: dto.country ?? "US", productUrl: null }
    throw new BadRequestException("需提供 asin 或 productUrl")
  }

  async run(
    dto: EvidenceRequestDto,
    resolved: { asin: string; country: string; productUrl: string | null },
    userId: number,
    emit: (ev: EvidenceSseEvent) => void
  ): Promise<void> {
    const { asin, country, productUrl } = resolved
    const warnings: string[] = []

    // 固定积分预检（仅取证模块场景：scene=audit 审计链取证免费，成本含在打分 20 内；
    // 非固定价模型返回 false 保持按量口径，无需预检）
    if (dto.scene === "evidence-module") {
      await this.billing.assertFixedStageAffordable(userId, dto.model, "evidence")
    }

    // 两路并行：爬虫 A/P/B 与 SIF D/C/E（SIF 主请求失败会 reject → 整体 error）
    const [abpc, de] = await Promise.all([
      this.collectAuditCards(dto, asin, country, productUrl, warnings, emit),
      this.collectDeCards(asin, country, warnings, emit),
    ])

    // B 卡评论分析按 scene 分流：evidence-module=双输出（亮点+痛点带 quote）；audit/缺省=现有差评痛点链路（原样）
    const B =
      dto.scene === "evidence-module"
        ? await this.enrichBWithAnalysis(dto, userId, warnings, emit, abpc)
        : await this.enrichBWithPainPoints(dto, userId, warnings, emit, abpc)

    const productSource = auditDataSource(abpc.raw?.data)
    const evidenceSource = productSource === "apify" ? ("apify" as const) : ("erp" as const)
    const hasReviewText = Boolean(abpc.raw && extractReviewComments(abpc.raw).commentList.length)
    const reviewTextMissingReason = hasReviewText
      ? undefined
      : productSource === "apify"
        ? "备用数据源未获取评论正文，暂无法生成评论亮点与痛点"
        : "商品详情未获取评论正文，暂无法生成评论亮点与痛点"
    if (reviewTextMissingReason && abpc.raw) {
      warnings.push(reviewTextMissingReason)
      emit({ type: "warning", message: reviewTextMissingReason })
    }
    const productChecklistItem = (fetched: boolean, missingReason?: string) =>
      this.checklistItem(fetched, productSource, missingReason, abpc.raw?.fetchedAt)

    const result: AuditEvidence = {
      asin,
      country,
      market: COUNTRY_MARKET[country] ?? "amazon_us",
      A: abpc.A,
      P: abpc.P,
      B,
      C: de.C,
      D: de.D,
      E: de.E,
      meta: {
        sources: {
          ...(abpc.A.filled ? { A: [evidenceSource] } : {}),
          ...(abpc.P.filled ? { P: [evidenceSource] } : {}),
          ...(B.filled ? { B: [evidenceSource] } : {}),
          ...(de.C.filled ? { C: ["mcp" as const] } : {}),
          D: ["sif"],
          E: ["sif"],
        },
        sifDataReady: de.meta.sifDataReady,
        sifWarnings: warnings,
        fetchedAt: new Date().toISOString(),
        estimatedPoints: de.meta.estimatedPoints,
      },
    }
    const checklist: EvidenceChecklist = {
      listing: productChecklistItem(Boolean(abpc.A.filled && abpc.A.title), "商品详情未返回标题"),
      qa: productChecklistItem((abpc.A.qa?.length ?? 0) > 0, "商品详情未返回 Q&A"),
      aplus: productChecklistItem(
        (abpc.A.aplusModules?.length ?? 0) > 0 ||
          (abpc.A.aplusImages?.length ?? 0) > 0 ||
          abpc.A.hasAplus === true,
        "商品详情未返回 A+ 内容"
      ),
      images: productChecklistItem((abpc.A.productImages?.length ?? 0) > 0, "商品详情未返回主副图"),
      params: productChecklistItem(abpc.P.filled, abpc.P.missingReason ?? "商品详情未返回参数"),
      reviews: {
        ...productChecklistItem(B.filled, B.missingReason ?? "商品详情未返回评分或评论数"),
        hasReviewText,
        ...(reviewTextMissingReason ? { reviewTextMissingReason } : {}),
        hasPainPoints: (B.richPainPoints?.length ?? 0) > 0,
        ...(dto.scene === "evidence-module"
          ? { hasHighlights: (B.highlights?.length ?? 0) > 0 }
          : {}),
      },
      traffic: this.checklistItem(de.D.filled, "sif", "SIF 流量数据不可用"),
      ads: {
        status: "skipped",
        note: "广告报表为用户上传链路（/api/ad-cleaning/tasks），本接口不包含",
      },
    }
    this.logger.log(
      `[asin-audit] evidence done userId=${userId} asin=${asin} cards=A:${abpc.A.filled},P:${abpc.P.filled},B:${B.filled},C:${de.C.filled},D:${de.D.filled},E:${de.E.filled} warnings=${warnings.length}`
    )
    // 固定积分扣费（成功后扣）：仅取证模块场景收 5；scene=audit 审计链取证不扣
    // （成本含在后续打分 20 内）。非固定价模型 chargeFixedStage 返回 false 不扣，
    // 内嵌 B 卡 AI 调用按量计费维持原口径。source 用取证专用子来源（label「ASIN 取证」）
    if (dto.scene === "evidence-module") {
      await this.billing.chargeFixedStage(
        userId,
        dto.model,
        "evidence",
        {
          scene: dto.scene,
          ...(dto.clientRequestId ? { clientRequestId: dto.clientRequestId } : {}),
        },
        ASIN_EVIDENCE_SOURCE
      )
    }
    emit({ type: "done", result, checklist })
  }

  /** 清单单项：fetched 带来源与时间；missing 带原因 */
  private checklistItem(
    fetched: boolean,
    source: EvidenceChecklistItem["source"],
    missingReason?: string,
    fetchedAt = new Date().toISOString()
  ): EvidenceChecklistItem {
    return fetched
      ? { status: "fetched", source, fetchedAt }
      : { status: "missing", source, missingReason }
  }

  /** 爬虫路：audit/detail 同源数据 → adapt A/P/B；失败降级空卡（不中断） */
  private async collectAuditCards(
    dto: EvidenceRequestDto,
    asin: string,
    country: string,
    productUrl: string | null,
    warnings: string[],
    emit: (ev: EvidenceSseEvent) => void
  ): Promise<{
    A: ListingEvidence
    P: ProductParamsEvidence
    B: ReviewEvidence
    raw: AuditDetailResponse | null
  }> {
    emit({ type: "progress", card: "A", message: "正在抓取商品详情（标题/五点/参数/评论）…" })
    const empty = {
      A: { filled: false } as ListingEvidence,
      P: { filled: false, missingReason: "商品详情抓取失败" } as ProductParamsEvidence,
      B: { filled: false, missingReason: "商品详情抓取失败" } as ReviewEvidence,
      raw: null,
    }
    try {
      const row = await this.audit.findDetail({
        ...(productUrl ? { url: productUrl } : {}),
        ...(productUrl ? {} : { asin }),
        country: country as Country,
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
      if (auditDataSource(resp.data) === "apify") {
        const message = "本次使用备用数据源，部分内容可能未获取。"
        warnings.push(message)
        emit({ type: "warning", message })
      }
      const adapted = adaptAuditDetail(resp)
      emit({ type: "evidence", card: "A", data: adapted.A })
      emit({ type: "evidence", card: "P", data: adapted.P })
      emit({ type: "evidence", card: "B", data: adapted.B })
      return { A: adapted.A, P: adapted.P, B: adapted.B, raw: resp }
    } catch {
      const msg = "商品详情暂时无法获取，请稍后重试"
      warnings.push(`ABPC 取证：${msg}`)
      emit({ type: "warning", message: `ABPC 取证：${msg}` })
      return empty
    }
  }

  /** SIF 路：等价迁移 fetch-de-evidence（D→C→E）；我方关键词主请求失败直接抛 → 整体 error */
  private async collectDeCards(
    asin: string,
    country: string,
    warnings: string[],
    emit: (ev: EvidenceSseEvent) => void
  ): Promise<DeEvidenceResult> {
    emit({ type: "progress", card: "D", message: "检查 SIF 数据就绪状态…" })
    let sifDataReady: boolean | null = null
    try {
      const ready = await this.sif.getLastDataTime(country, "last_30d")
      sifDataReady = this.checkDataReady(ready.list ?? [], ["asinKeywordSummary", "last_30d"])
      for (const w of this.dataReadyWarnings(ready.list ?? [], [
        "asinKeywordSummary",
        "last_30d",
      ])) {
        warnings.push(w)
        emit({ type: "warning", message: w })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      warnings.push(`数据就绪检查跳过：${msg}`)
      emit({ type: "warning", message: `数据就绪检查跳过：${msg}` })
    }

    emit({ type: "progress", card: "D", message: "正在反查近 30 天核心流量词…" })
    const kwResp = await this.sif.asinKeywordsMonthly(country, [asin], { last30d: true })

    const topKeywords = (kwResp.list ?? []).slice(0, 10).map(k => k.keyword)
    emit({
      type: "progress",
      card: "D",
      message: `补全 ${topKeywords.length} 个关键词搜索量…`,
    })
    const overview = topKeywords.length
      ? await this.sif.batchKeywordOverview(country, topKeywords)
      : []

    const D = adaptKeywordTrafficD(kwResp, overview)
    emit({ type: "evidence", card: "D", data: D })

    // C 卡：按目标 ASIN 查同款竞品（MCP asin_competitor），配件/周边过滤后取前 3，再反查竞品关键词。
    // 曾用 keyword 版 competitor_lookup（D 卡 Top1 词查榜）——关键词宽匹配+按销量排序会被
    // 配件/耗材霸榜（HP 笔记本查出打印纸），已废弃。
    let C: DeEvidenceResult["C"] = { filled: false, missingReason: "未找到竞品 ASIN" }
    try {
      emit({ type: "progress", card: "C", message: "正在按 ASIN 查询同类竞品…" })
      const { items } = await this.mcp.callAsinCompetitor(asin, country, 10)
      const candidates = items
        .map(it => ({
          asin: typeof it.asin === "string" ? it.asin.trim() : "",
          title: typeof it.title === "string" ? it.title : undefined,
          brand: typeof it.brand === "string" ? it.brand : undefined,
          nodeLabelPath: typeof it.nodeLabelPath === "string" ? it.nodeLabelPath : undefined,
        }))
        .filter(c => c.asin.length > 0)

      if (!candidates.length) {
        C = { filled: false, missingReason: "未找到竞品 ASIN" }
      } else {
        // 目标标题/品牌做过滤参照；拿不到则跳过过滤（缺参照宁可放行，避免误杀）
        let targetRef: { title?: string; brand?: string } = {}
        try {
          const detail = await this.sif.batchAsinDetail(country, [asin])
          targetRef = { title: detail.list?.[0]?.title, brand: detail.list?.[0]?.brand }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          warnings.push(`竞品品类过滤参照获取失败，跳过过滤：${msg}`)
          emit({ type: "warning", message: `竞品品类过滤参照获取失败，跳过过滤：${msg}` })
        }
        const { kept, dropped } = filterCompetitorCandidates(candidates, targetRef, 3)
        for (const d of dropped) {
          warnings.push(`竞品 ${d.asin} 已过滤：${d.reason}`)
          emit({ type: "warning", message: `竞品 ${d.asin} 已过滤：${d.reason}` })
        }
        const competitorAsins = kept.map(k => k.asin)

        if (!competitorAsins.length) {
          C = { filled: false, missingReason: "竞品经配件/周边过滤后无匹配" }
        } else {
          emit({
            type: "progress",
            card: "C",
            message: `反查 ${competitorAsins.length} 个竞品的关键词…`,
          })
          const compKwResp = await this.sif.asinKeywordsMonthly(country, competitorAsins, {
            last30d: true,
          })
          const compTopKws = (compKwResp.list ?? []).slice(0, 20).map(k => k.keyword)
          const compOverview = compTopKws.length
            ? await this.sif.batchKeywordOverview(country, compTopKws)
            : []
          C = adaptCompetitorC(competitorAsins, compKwResp, compOverview, D.kwTop[0]?.kw ?? "")
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      warnings.push(`竞品查询失败：${msg}`)
      emit({ type: "warning", message: `竞品查询失败：${msg}` })
      C = { filled: false, missingReason: msg }
    }
    emit({ type: "evidence", card: "C", data: C })

    const { startDate, endDate } = trendDateRange()
    emit({ type: "progress", card: "E", message: "正在拉取前台销量与 BSR 趋势…" })
    const [sales, price, trend] = await Promise.all([
      this.sif.variantLastSales(country, asin).catch((e: unknown) => {
        warnings.push(`前台销量获取失败：${e instanceof Error ? e.message : String(e)}`)
        return []
      }),
      this.sif.batchAsinPrice(country, [asin]).catch((e: unknown) => {
        warnings.push(`价格/coupon 获取失败：${e instanceof Error ? e.message : String(e)}`)
        return { list: [] }
      }),
      this.sif
        .asinOpTrafficTrend(country, asin, startDate, endDate)
        .then(data => {
          if (data) return data
          const message = `未查询到该 ASIN 在 Amazon ${country} 的运营趋势数据`
          warnings.push(message)
          emit({ type: "warning", message })
          return {}
        })
        .catch((e: unknown) => {
          warnings.push(`BSR 趋势获取失败：${e instanceof Error ? e.message : String(e)}`)
          return {}
        }),
    ])

    const E = adaptAsinPerformanceE(asin, sales, price, trend)

    // I3 排名趋势（BSR 口径）：30 天日级序列已在 hand，裁近 14 天算前 7 vs 后 7 挂进 D 卡预计算块
    if (D.trafficPrecompute) {
      D.trafficPrecompute.bsrTrend = computeBsrTrendPrecompute(trend)
      // trend 就绪后 D 卡重推一次（含 bsrTrend，供前端流式渲染走势图）——B 卡基础版→增强版双推同款，覆盖渲染
      emit({ type: "evidence", card: "D", data: D })
    }
    emit({ type: "evidence", card: "E", data: E })

    // 单次 D+C+E：lastDataTime(0) + kwMonthly(1) + overview(≤10) + asinDetail 目标参照(1)
    //   + sales(1) + price(2) + trend(1)；竞品反查词与 MCP 竞品查询沿用原口径不计入
    const estimatedPoints = 2 + Math.min(topKeywords.length, 10) + 1 + 2 + 1

    return {
      asin,
      country,
      C,
      D,
      E,
      meta: {
        sources: { C: C.filled ? ["mcp"] : undefined, D: ["sif"], E: ["sif"] },
        sifDataReady,
        sifWarnings: warnings,
        fetchedAt: new Date().toISOString(),
        estimatedPoints,
      },
    }
  }

  private checkDataReady(
    modules: { moduleCode: string; dataReady: boolean }[],
    codes: string[]
  ): boolean | null {
    if (!modules?.length) return null
    for (const code of codes) {
      const mod = modules.find(m => m.moduleCode === code)
      if (mod && mod.dataReady === false) return false
    }
    return true
  }

  private dataReadyWarnings(
    modules: { moduleCode: string; name: string; dataReady: boolean }[],
    codes: string[]
  ): string[] {
    if (!modules?.length) return []
    const warnings: string[] = []
    for (const code of codes) {
      const mod = modules.find(m => m.moduleCode === code)
      if (mod && mod.dataReady === false) {
        warnings.push(`${mod.name ?? code} 数据尚未就绪（dataReady=false）`)
      }
    }
    return warnings
  }

  /** B 卡 AI 痛点：评论非空调痛点服务（含计费）；失败/空评论回退基础卡 */
  private async enrichBWithPainPoints(
    dto: EvidenceRequestDto,
    userId: number,
    warnings: string[],
    emit: (ev: EvidenceSseEvent) => void,
    abpc: {
      A: ListingEvidence
      P: ProductParamsEvidence
      B: ReviewEvidence
      raw: AuditDetailResponse | null
    }
  ): Promise<ReviewEvidence> {
    const baseB = abpc.B
    if (!baseB.filled || !abpc.raw) return baseB

    const comments = extractReviewComments(abpc.raw)
    if (!comments.commentList.length) return baseB

    emit({ type: "progress", card: "B", message: "正在分析评论 Top5 痛点…" })
    try {
      const painPointsDto: ReviewPainPointsDto = {
        model: dto.model,
        commentList: comments.commentList,
        ...(comments.starPercent.length ? { starPercent: comments.starPercent } : {}),
        ...(comments.reviewCount !== undefined ? { reviewCount: comments.reviewCount } : {}),
        ...(dto.responseLanguage ? { responseLanguage: dto.responseLanguage } : {}),
        ...(dto.clientRequestId ? { clientRequestId: dto.clientRequestId } : {}),
      }
      // 固定价模型时跳过内嵌按量扣费（审计链免费 / 取证模块由流程价 5 覆盖）
      const outcome = await this.painPoints.run(painPointsDto, userId, {
        skipUsageCharge: isAsinAuditFixedModel(dto.model),
      })
      if (!outcome.painPoints.length) return baseB
      const enriched: ReviewEvidence = { ...baseB, richPainPoints: outcome.painPoints }
      emit({ type: "evidence", card: "B", data: enriched })
      return enriched
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      warnings.push(`评论痛点分析失败：${msg}`)
      emit({ type: "warning", message: `评论痛点分析失败：${msg}` })
      return baseB
    }
  }

  /** module 场景：评论分析双输出（好评亮点 + 差评痛点带 quote）；失败降级基础卡（不中断） */
  private async enrichBWithAnalysis(
    dto: EvidenceRequestDto,
    userId: number,
    warnings: string[],
    emit: (ev: EvidenceSseEvent) => void,
    abpc: {
      A: ListingEvidence
      P: ProductParamsEvidence
      B: ReviewEvidence
      raw: AuditDetailResponse | null
    }
  ): Promise<ReviewEvidence> {
    const baseB = abpc.B
    if (!baseB.filled || !abpc.raw) return baseB

    const comments = extractReviewComments(abpc.raw)
    if (!comments.commentList.length) return baseB

    emit({ type: "progress", card: "B", message: "正在分析评论亮点与痛点…" })
    try {
      const analysisDto: ReviewPainPointsDto = {
        model: dto.model,
        commentList: comments.commentList,
        ...(comments.starPercent.length ? { starPercent: comments.starPercent } : {}),
        ...(comments.reviewCount !== undefined ? { reviewCount: comments.reviewCount } : {}),
        ...(dto.responseLanguage ? { responseLanguage: dto.responseLanguage } : {}),
        ...(dto.clientRequestId ? { clientRequestId: dto.clientRequestId } : {}),
      }
      // 固定价模型时跳过内嵌按量扣费（取证模块由流程价 5 覆盖）；
      // 非固定价模型按量回落时用取证专用 source，meta.scene 供区分审计链
      const outcome = await this.reviewAnalysis.run(analysisDto, userId, {
        skipUsageCharge: isAsinAuditFixedModel(dto.model),
        source: ASIN_EVIDENCE_SOURCE,
        meta: { scene: dto.scene },
      })
      if (!outcome.highlights.length && !outcome.painPoints.length) return baseB
      const enriched: ReviewEvidence = {
        ...baseB,
        ...(outcome.painPoints.length ? { richPainPoints: outcome.painPoints } : {}),
        ...(outcome.highlights.length ? { highlights: outcome.highlights } : {}),
      }
      emit({ type: "evidence", card: "B", data: enriched })
      return enriched
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      warnings.push(`评论分析失败：${msg}`)
      emit({ type: "warning", message: `评论分析失败：${msg}` })
      return baseB
    }
  }

  /** SIF 错误 → 流内 error 事件结构 */
  toErrorEvent(err: unknown): { message: string; code?: number } {
    if (err instanceof SifApiError) {
      return { message: err.message, code: err.code }
    }
    return { message: err instanceof Error ? err.message : "取证失败" }
  }
}
