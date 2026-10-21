import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import { InvokeType, OpenApiApp, Prisma } from "@prisma/client"
import { randomBytes } from "node:crypto"
import { assembleCompetitorAnalysis } from "../competitor-analysis/competitor-analysis.assembler"
import { CompetitorEvidenceBundle } from "../competitor-analysis/competitor-analysis.types"
import { CompetitorEvidenceProvider } from "../competitor-analysis/competitor-evidence.provider"
import { KEEPA_CSV, keepaProduct } from "../competitor-analysis/competitor-keepa"
import { PricingService } from "../pricing/pricing.service"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { buildCompetitorOperationDetail } from "./competitor-operation-detail"
import { NIUNIU_BILLING_PHONE } from "./niuniu-billing"
import { parseOperationProductUrl } from "./operation-plan-product.service"
import { OPERATION_PLAN_CURRENCIES } from "./operation-plan-result"

type DataRecord = Record<string, unknown>
function asRecord(value: unknown): DataRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as DataRecord) : {}
}
function records(value: unknown): DataRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}
function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}
function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
}

// 单链接商品资料3次SIF，历史数据2次SIF和1次Keepa。
const MAX_PRODUCT_ANALYSIS_CALLS = 6
const MAX_OPERATION_DETAIL_CALLS = 4

/** 事实数据按成功调用次数结算 MCP 费用，不调用AI、不复用未来运营计划。 */
@Injectable()
export class OpenProductAnalysisService {
  constructor(
    private readonly evidence: CompetitorEvidenceProvider,
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly pricing: PricingService
  ) {}

  async query(app: OpenApiApp, url: string) {
    return this._query(app, url, "price")
  }

  async queryOperations(app: OpenApiApp, url: string) {
    return this._query(app, url, "operations")
  }

  private async _query(app: OpenApiApp, url: string, view: "price" | "operations") {
    const isOperationDetail = view === "operations"
    const maxCalls = isOperationDetail ? MAX_OPERATION_DETAIL_CALLS : MAX_PRODUCT_ANALYSIS_CALLS
    const billingSource = isOperationDetail ? "open.operation-plan.query" : "open.product-analysis"
    if (!app.isNiuniuOperationPlanEnabled)
      throw new ForbiddenException("当前接入方未开通牛牛运营计划接口")
    const link = parseOperationProductUrl(url)
    const user = await this.prisma.user.findUnique({
      where: { phone: NIUNIU_BILLING_PHONE },
      select: { id: true, isActive: true },
    })
    if (!user?.isActive)
      throw new ForbiddenException({
        code: "OPEN_PLAN_ACCOUNT_UNAVAILABLE",
        message: "牛牛专用扣费账号不存在或已停用",
      })
    const unitPrice = await this.pricing.getMcpCallPrice()
    if (!unitPrice.isFinite() || unitPrice.lte(0))
      throw new BadRequestException("MCP 调用单价必须大于0")
    const maximumCost = unitPrice.mul(maxCalls)
    if (app.perCallMaxCny != null && app.perCallMaxCny.lt(maximumCost))
      throw new BadRequestException({
        code: "OPEN_PRODUCT_BILLING_LIMIT",
        message: "商品分析预计费用超过接入方单笔上限",
      })
    await this.usage.assertGatewayAffordable(user.id, maximumCost)
    const requestId = randomBytes(32).toString("hex")
    const [profileResult, historyResult] = await Promise.allSettled([
      isOperationDetail
        ? this.evidence.collectOperationProductEvidence(link.country, link.asin)
        : this.evidence.collectModuleEvidence(link.country, [link.asin], "profile"),
      this.evidence.collectProductHistoryEvidence(link.country, link.asin),
    ])
    if (profileResult.status === "rejected") throw profileResult.reason
    const profileEvidence = profileResult.value
    const profile = assembleCompetitorAnalysis(profileEvidence).profiles[0]
    if (!profile?.found || typeof profile.title !== "string" || !profile.title.trim())
      throw new BadGatewayException({
        code: "OPEN_PLAN_PRODUCT_UNAVAILABLE",
        message: "未能获取该链接的有效商品资料，本次不扣积分",
      })
    const warnings: string[] = []
    const history = historyResult.status === "fulfilled" ? historyResult.value : null
    if (!history) warnings.push("历史数据源暂不可用，价格曲线及历史运营阶段可能缺失")
    const merged: CompetitorEvidenceBundle = {
      ...profileEvidence,
      sif: {
        ...profileEvidence.sif,
        ...history?.sif,
        profile: profileEvidence.sif.profile,
        monthlySales: profileEvidence.sif.monthlySales,
      },
      keepa: history?.keepa ?? null,
      sources: [...profileEvidence.sources, ...(history?.sources ?? [])],
    }
    const board = assembleCompetitorAnalysis(merged).pricePromoBoards[0]
    const collectedAt = history?.collectedAt ?? profileEvidence.collectedAt
    const endDate = collectedAt.slice(0, 10)
    const startDate = addDays(endDate, -29)
    const series = asRecord(board.series)
    const channels = records(series.channels)
    // 同一条曲线只采用一个渠道，不混拼不同报价口径；只返回窗口内真实采样。
    const candidates = ["buyBox", "amazon", "new", "fba", "fbm", "prime"]
    const channel = candidates
      .map(key => channels.find(item => item.key === key))
      .find(
        item =>
          item &&
          records(item.points).some(
            point =>
              validDate(point.date) &&
              point.date >= startDate &&
              point.date <= endDate &&
              positive(point.value) !== null
          )
      )
    const points = records(channel?.points)
      .filter(
        point =>
          validDate(point.date) &&
          point.date >= startDate &&
          point.date <= endDate &&
          positive(point.value) !== null
      )
      .map(point => ({
        date: String(point.date),
        // 公共Keepa解码器统一按100缩放；日元原始值本身就是元，在对外口径恢复。
        price: Number(point.value) * (series.source === "keepa" && link.country === "JP" ? 100 : 1),
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
    const priceCurve = {
      status: points.length >= 2 ? "available" : points.length ? "partial" : "unavailable",
      startDate,
      endDate,
      rangeDays: 30,
      source: points.length ? String(series.source) : null,
      channel: points.length ? String(channel?.key) : null,
      points,
    }
    if (!isOperationDetail && points.length < 2)
      warnings.push("近30天有效历史价格不足两个采样点，不能绘制完整价格曲线")
    const product = keepaProduct(history?.keepa?.[link.asin], link.asin)
    const current = asRecord(product?.stats).current
    const rawListPrice = Array.isArray(current) ? positive(current[KEEPA_CSV.LISTPRICE]) : null
    const listPrice =
      rawListPrice === null ? null : rawListPrice / (link.country === "JP" ? 1 : 100)
    const sales = records(profile.salesTrend)
      .filter(
        item =>
          typeof item.month === "string" &&
          /^\d{4}-\d{2}$/.test(item.month) &&
          item.month <= endDate.slice(0, 7) &&
          typeof item.sales === "number" &&
          Number.isFinite(item.sales) &&
          item.sales >= 0
      )
      .sort((a, b) => String(a.month).localeCompare(String(b.month)))
      .at(-1)
    const historicalOperations = buildHistoricalOperations(asRecord(board.sop), endDate)
    if (!isOperationDetail && listPrice === null)
      warnings.push("数据源未提供当前有效划线价，不按折扣比例推算")
    if (!isOperationDetail && !sales) warnings.push("数据源未提供月销量，返回null而非0")
    if (!historicalOperations.rows.length)
      warnings.push("缺少足够历史运营信号，暂不生成历史运营甘特")
    const result = isOperationDetail
      ? {
          schemaVersion: 1,
          asin: link.asin,
          url: link.url,
          platform: "amazon",
          market: link.market,
          title: profile.title,
          currency: OPERATION_PLAN_CURRENCIES[link.market],
          collectedAt,
          sources: merged.sources,
          operationScheme: buildCompetitorOperationDetail(
            asRecord(board.sop),
            historicalOperations,
            endDate,
            link.country
          ),
          warnings,
        }
      : {
          schemaVersion: 1,
          asin: link.asin,
          url: link.url,
          platform: "amazon",
          market: link.market,
          title: profile.title,
          currency: OPERATION_PLAN_CURRENCIES[link.market],
          price: positive(profile.price),
          listPrice,
          monthlySales: sales ? Number(sales.sales) : null,
          monthlySalesPeriod: sales ? String(sales.month) : null,
          monthlySalesBasis: sales ? "calendar_month" : null,
          fieldSources: {
            price: positive(profile.price) === null ? null : "sif",
            listPrice: listPrice === null ? null : "keepa",
            monthlySales: sales ? "sif" : null,
          },
          priceCurve,
          historicalOperations,
          collectedAt,
          warnings,
        }
    const callDetail = { sif: 0, keepa: 0 }
    for (const bundle of [profileEvidence, history]) {
      for (const source of ["sif", "keepa"] as const) {
        const count = bundle?.callDetail[source] ?? 0
        if (!Number.isSafeInteger(count) || count < 0)
          throw new BadGatewayException("数据源返回的调用次数无效，本次不扣积分")
        callDetail[source] += count
      }
    }
    const calls = callDetail.sif + callDetail.keepa
    if (calls > maxCalls) throw new BadGatewayException("数据源调用次数超出预检范围，本次不扣积分")
    const charged = calls
      ? await this.prisma.$transaction(
          tx =>
            this.usage.chargeMcpInTransaction(
              tx,
              user.id,
              {
                calls,
                source: billingSource,
                requestId,
                requestParams: { url: link.url },
                meta: {
                  appId: app.appId,
                  externalRequestId: requestId,
                  billingChannel: billingSource,
                  businessEventId: requestId,
                  sourceUrl: link.url,
                  asin: link.asin,
                  country: link.country,
                  callDetail,
                },
              },
              { invokeType: InvokeType.API, unitPriceCny: unitPrice }
            ),
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30000 }
        )
      : null
    return {
      ...result,
      requestId,
      billingHandled: true,
      billing: {
        calls,
        callDetail,
        costCny: charged?.costCny.toString() ?? "0",
        creditsCharged: charged?.creditsCharged.toString() ?? "0",
      },
    }
  }
}

export function buildHistoricalOperations(sop: DataRecord, collectedDate: string) {
  const weeks = records(sop.weeks)
  const bucketDays = typeof sop.bucketDays === "number" && sop.bucketDays >= 1 ? sop.bucketDays : 7
  const rows = records(sop.rows)
    .filter(row => row.truthLevel === "truth" || row.truthLevel === "inference")
    .flatMap(row => {
      const segments = records(row.cells).flatMap((cell, index) => {
        const startDate = weeks[index]?.startDate
        if (
          cell.active !== true ||
          !validDate(startDate) ||
          startDate > collectedDate ||
          !["sif", "keepa"].includes(String(cell.source)) ||
          cell.label === "数据不足"
        )
          return []
        return [
          {
            startDate,
            endDate: [addDays(startDate, bucketDays - 1), collectedDate].sort()[0],
            label: typeof cell.label === "string" ? cell.label : String(row.label),
            source: String(cell.source),
          },
        ]
      })
      return segments.length
        ? [
            {
              key: String(row.key),
              label: String(row.label),
              truthLevel: row.truthLevel === "truth" ? "observed" : "inferred",
              summary: typeof row.summary === "string" ? row.summary : "",
              segments,
            },
          ]
        : []
    })
  const segments = rows.flatMap(row => row.segments)
  return {
    kind: "historical_operations",
    status: rows.length ? "available" : "unavailable",
    startDate: segments.map(item => item.startDate).sort()[0] ?? null,
    endDate:
      segments
        .map(item => item.endDate)
        .sort()
        .at(-1) ?? null,
    bucketDays,
    currentStage:
      rows.some(row => row.key === "stage") &&
      typeof sop.stage === "string" &&
      sop.stage !== "数据不足"
        ? sop.stage
        : null,
    rows,
    disclaimer: "历史信号及运营阶段推断，不代表竞品实际后台操作；与未来运营计划排期无关",
  }
}
