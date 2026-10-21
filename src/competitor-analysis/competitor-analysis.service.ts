import { DomesticBusinessGateway } from "../common/business-ai/domestic-business-gateway"
import { Inject, BadGatewayException, ConflictException, Injectable, Logger } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { createHash, randomUUID } from "node:crypto"
import {
  AiGatewayProvider,
  type AiGatewayBillingUsage,
  type AiGatewayTokenUsage,
} from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { CompetitorAnalysisRecordService } from "./competitor-analysis-record.service"
import { assembleCompetitorAnalysis } from "./competitor-analysis.assembler"
import { buildCompetitorAnalysisPrompts } from "./competitor-analysis.prompts"
import {
  AiCompetitorAnalysis,
  AssembledCompetitorAnalysis,
  CompetitorAnalysisModuleId,
  CompetitorAnalysisResponse,
  CompetitorAnalysisSummaryResponse,
  CompetitorEvidenceBundle,
} from "./competitor-analysis.types"
import { CompetitorEvidenceProvider } from "./competitor-evidence.provider"
import { AnalyzeCompetitorsDto } from "./dto/analyze-competitors.dto"
import { SummarizeCompetitorsDto } from "./dto/summarize-competitors.dto"

interface MarketplaceCapability {
  marketplace: string
  label: string
  flag: string
  currency: string
  locale: string
  sif: { status: "supported" }
  profile: { status: "supported" }
  traffic: { status: "supported" }
  pricePromo: { status: "supported" }
  keepaHistory: { status: "supported" | "not_supported"; domain: number | null }
}

interface ModuleItem {
  asin: string
  status: "success" | "unavailable"
  coverage: "complete" | "partial" | "none"
  data: Record<string, unknown> | null
  sources: Array<Record<string, unknown>>
  issues: Array<Record<string, unknown>>
}

interface CompetitorRunBillingSnapshot {
  billing: AiGatewayBillingUsage
  tokenUsage: AiGatewayTokenUsage
}

const MARKET_META: Record<string, [string, string, string, string, number | null]> = {
  US: ["Amazon US", "🇺🇸", "USD", "en-US", 1],
  UK: ["Amazon UK", "🇬🇧", "GBP", "en-GB", 2],
  DE: ["Amazon Germany", "🇩🇪", "EUR", "de-DE", 3],
  CA: ["Amazon Canada", "🇨🇦", "CAD", "en-CA", 6],
  JP: ["Amazon Japan", "🇯🇵", "JPY", "ja-JP", 5],
  FR: ["Amazon France", "🇫🇷", "EUR", "fr-FR", 4],
  ES: ["Amazon Spain", "🇪🇸", "EUR", "es-ES", 9],
  IT: ["Amazon Italy", "🇮🇹", "EUR", "it-IT", 8],
  MX: ["Amazon Mexico", "🇲🇽", "MXN", "es-MX", 11],
  AU: ["Amazon Australia", "🇦🇺", "AUD", "en-AU", 13],
  AE: ["Amazon UAE", "🇦🇪", "AED", "ar-AE", null],
  BR: ["Amazon Brazil", "🇧🇷", "BRL", "pt-BR", 12],
  SA: ["Amazon Saudi Arabia", "🇸🇦", "SAR", "ar-SA", null],
}

const COMPETITOR_TRANSACTION_MAX_WAIT_MS = 10_000
const COMPETITOR_TRANSACTION_TIMEOUT_MS = 60_000

@Injectable()
export class CompetitorAnalysisService {
  private readonly logger = new Logger(CompetitorAnalysisService.name)

  constructor(
    private readonly evidenceProvider: CompetitorEvidenceProvider,
    @Inject(DomesticBusinessGateway) private readonly aiGatewayProvider: AiGatewayProvider,
    private readonly usageService: UsageService,
    private readonly prisma: PrismaService,
    private readonly recordService: CompetitorAnalysisRecordService
  ) {}

  async analyze(userId: number, dto: AnalyzeCompetitorsDto): Promise<CompetitorAnalysisResponse> {
    await this.assertAffordable(userId, dto.asins)
    const startedAt = new Date().toISOString()
    const evidence = await this.evidenceProvider.collectEvidence(dto.country, dto.asins)
    const assembled = assembleCompetitorAnalysis(evidence)
    const prompts = buildCompetitorAnalysisPrompts(evidence, assembled)
    const gatewayResult = await this.aiGatewayProvider.generateJson<AiCompetitorAnalysis>(
      prompts.systemPrompt,
      prompts.userPrompt,
      {
        isDataValid: value => this._isAnalysisComplete(value),
        retryInstruction:
          "顶层必须且只能包含 summary；summary 必须同时包含 insights 数组和 rankings 数组，两个数组都不可省略。",
        model: dto.model,
        resolveBilling: true,
      }
    )
    const analysis = this._normalizeAnalysis(gatewayResult.data)
    const snapshot = this._buildSnapshot(dto, evidence, assembled, analysis, startedAt)
    if (this._isAnalysisComplete(gatewayResult.data))
      await this._charge(userId, "analyze", dto.country, dto.asins, gatewayResult, dto.runId)

    return {
      snapshot,
      tokenUsage: gatewayResult.tokenUsage,
      gateway: { model: gatewayResult.model, requestId: gatewayResult.requestId },
      billingHandled: true,
    }
  }

  async assertAffordable(userId: number, asins: string[]) {
    return this.usageService.assertFixedModuleAffordable(userId, "competitor.research", undefined, undefined, new Set(asins).size)
  }

  analyzeProfile(dto: AnalyzeCompetitorsDto): Promise<Record<string, unknown>> {
    return this._analyzeModule(dto, "profile")
  }

  analyzeTraffic(dto: AnalyzeCompetitorsDto): Promise<Record<string, unknown>> {
    return this._analyzeModule(dto, "traffic")
  }

  analyzePricePromo(dto: AnalyzeCompetitorsDto): Promise<Record<string, unknown>> {
    return this._analyzeModule(dto, "pricePromo")
  }

  async summarize(
    userId: number,
    dto: SummarizeCompetitorsDto
  ): Promise<CompetitorAnalysisSummaryResponse> {
    const modules = this._asRecord(dto.modules)
    const profileModule = this._asRecord(modules.profile)
    const trafficModule = this._asRecord(modules.traffic)
    const pricePromoModule = this._asRecord(modules.pricePromo)
    const assembled: AssembledCompetitorAnalysis = {
      profiles: this._normalizeProfiles(
        this._asArray(profileModule.profiles).map(value => this._asRecord(value)),
        dto.asins
      ),
      trafficBoards: this._normalizeTrafficBoards(
        this._asArray(trafficModule.boards).map(value => this._asRecord(value)),
        dto.asins
      ),
      pricePromoBoards: this._normalizePricePromoBoards(
        this._asArray(pricePromoModule.boards).map(value => this._asRecord(value)),
        dto.asins
      ),
    }
    const evidence: CompetitorEvidenceBundle = {
      country: dto.country,
      asins: dto.asins,
      collectedAt: new Date().toISOString(),
      sif: {},
      sellerSprite: null,
      keepa: null,
      sources: [],
      callDetail: {},
    }
    const prompts = buildCompetitorAnalysisPrompts(evidence, assembled)
    const recovered = await this._prepareSummaryRun(userId, dto, prompts)
    let analysis: AiCompetitorAnalysis
    let billing: AiGatewayBillingUsage
    let tokenUsage: AiGatewayTokenUsage
    let gatewayModel: string
    let gatewayRequestId: string | null

    if (recovered) {
      analysis = this._normalizeAnalysis(JSON.parse(recovered.outputText))
      billing = recovered.billing.billing
      tokenUsage = recovered.billing.tokenUsage
      gatewayModel = billing.model
      gatewayRequestId = billing.requestId
    } else {
      try {
        await this.assertAffordable(userId, dto.asins)
        const gatewayResult = await this.aiGatewayProvider.generateJson<AiCompetitorAnalysis>(
          prompts.systemPrompt,
          prompts.userPrompt,
          {
            isDataValid: value => this._isAnalysisComplete(value),
            retryInstruction:
              "顶层必须且只能包含 summary；summary 必须同时包含 insights 数组和 rankings 数组，两个数组都不可省略。",
            model: dto.model,
            resolveBilling: true,
          }
        )
        if (!gatewayResult.billing) throw new BadGatewayException("AI 中转站未返回计费结果")
        if (!this._isAnalysisComplete(gatewayResult.data))
          throw new BadGatewayException("竞品分析结果不完整，本次未扣积分")
        analysis = this._normalizeAnalysis(gatewayResult.data)
        billing = gatewayResult.billing
        tokenUsage = gatewayResult.tokenUsage
        gatewayModel = gatewayResult.model
        gatewayRequestId = gatewayResult.requestId
        await this._saveSummaryOutput(userId, dto, gatewayResult.data, billing, tokenUsage)
      } catch (error) {
        await this._markSummaryRunFailed(userId, dto, error)
        throw error
      }
    }

    const summary = this._normalizeSummary(analysis.summary, dto.asins)
    const record = await this._archiveSummaryRecord(userId, dto, summary)
    await this._finalizeSummaryRun(userId, dto, billing, tokenUsage)

    return {
      summary,
      recordId: record.recordId,
      tokenUsage,
      gateway: { model: gatewayModel, requestId: gatewayRequestId },
      billingHandled: true,
    }
  }

  private async _prepareSummaryRun(
    userId: number,
    dto: SummarizeCompetitorsDto,
    prompts: { systemPrompt: string; userPrompt: string }
  ): Promise<{
    outputText: string
    billing: CompetitorRunBillingSnapshot
  } | null> {
    if (!dto.runId) return null
    const inputHash = createHash("sha256")
      .update(
        JSON.stringify({
          systemPrompt: prompts.systemPrompt,
          userPrompt: prompts.userPrompt,
          model: dto.model,
        })
      )
      .digest("hex")
    const where = {
      userId_module_operation_runId: {
        userId,
        module: "competitor-analysis",
        operation: "summary",
        runId: dto.runId,
      },
    }
    const existing = await this.prisma.businessAiRun.findUnique({ where })
    if (existing) {
      if (existing.inputHash !== inputHash) throw new ConflictException("运行号已被其他输入使用")
      if (existing.outputText && existing.billing) {
        return {
          outputText: existing.outputText,
          billing: existing.billing as unknown as CompetitorRunBillingSnapshot,
        }
      }
      if (existing.status === "RUNNING") {
        throw new ConflictException("本次竞品分析仍在执行，请稍后重试读取结果")
      }
      const claimed = await this.prisma.businessAiRun.updateMany({
        where: { id: existing.id, status: "FAILED", outputText: null },
        data: { status: "RUNNING", error: null },
      })
      if (claimed.count === 0) throw new ConflictException("本次竞品分析正在恢复")
      return null
    }

    try {
      await this.prisma.businessAiRun.create({
        data: {
          userId,
          runId: dto.runId,
          module: "competitor-analysis",
          operation: "summary",
          model: dto.model,
          inputHash,
        },
      })
      return null
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error
      }
      throw new ConflictException("本次竞品分析正在执行，请稍后读取结果")
    }
  }

  private async _saveSummaryOutput(
    userId: number,
    dto: SummarizeCompetitorsDto,
    output: unknown,
    billing: AiGatewayBillingUsage,
    tokenUsage: AiGatewayTokenUsage
  ): Promise<void> {
    if (!dto.runId) return
    const snapshot: CompetitorRunBillingSnapshot = { billing, tokenUsage }
    const updated = await this.prisma.businessAiRun.updateMany({
      where: {
        userId,
        module: "competitor-analysis",
        operation: "summary",
        runId: dto.runId,
        status: "RUNNING",
      },
      data: {
        status: "READY",
        requestId: billing.requestId,
        outputText: JSON.stringify(output),
        billing: snapshot as unknown as Prisma.InputJsonValue,
        error: null,
      },
    })
    if (updated.count !== 1) throw new BadGatewayException("竞品分析运行记录保存失败")
  }

  private async _archiveSummaryRecord(
    userId: number,
    dto: SummarizeCompetitorsDto,
    summary: AiCompetitorAnalysis["summary"]
  ) {
    const snapshot = this._asRecord(dto.recordSnapshot)
    const profiles = this._asArray(snapshot.profiles).map(value => this._asRecord(value))
    const boards = this._asArray(snapshot.boards).map(value => this._asRecord(value))
    const priceBoards = this._asArray(snapshot.priceBoards).map(value => this._asRecord(value))
    const profileByAsin = new Map(profiles.map(item => [String(item.asin).toUpperCase(), item]))
    const trafficByAsin = new Map(boards.map(item => [String(item.asin).toUpperCase(), item]))
    const priceByAsin = new Map(priceBoards.map(item => [String(item.asin).toUpperCase(), item]))
    const clientRequestId =
      dto.runId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(dto.runId)
        ? dto.runId
        : randomUUID()

    return this.recordService.create(userId, {
      clientRequestId,
      schemaVersion: 1,
      marketplace: dto.country,
      input: {
        mode: "ASIN",
        ownAsin: null,
        competitorAsins: dto.asins,
        keyword: null,
        sourceText: dto.asins.join("\n"),
      },
      analysisResult: {
        analyzedAsins: dto.asins,
        summary: summary as unknown as Record<string, unknown>,
      },
      products: dto.asins.map((asin, sortOrder) => {
        const profile = profileByAsin.get(asin) ?? { asin }
        const traffic = trafficByAsin.get(asin)
        const pricePromo = priceByAsin.get(asin)
        return {
          asin,
          sortOrder,
          productData: profile,
          steps: [
            ...(traffic
              ? [{ stepCode: "TRAFFIC", stepNo: 1, schemaVersion: 1, resultData: traffic }]
              : []),
            ...(pricePromo
              ? [{ stepCode: "PRICE_PROMO", stepNo: 2, schemaVersion: 1, resultData: pricePromo }]
              : []),
          ],
        }
      }),
      reportData: { profiles, boards, priceBoards },
    })
  }

  private async _finalizeSummaryRun(
    userId: number,
    dto: SummarizeCompetitorsDto,
    billing: AiGatewayBillingUsage,
    tokenUsage: AiGatewayTokenUsage
  ): Promise<void> {
    if (!dto.runId) {
      await this._charge(
        userId,
        "summary",
        dto.country,
        dto.asins,
        { billing, tokenUsage },
        dto.runId
      )
      return
    }
    await this.prisma.$transaction(
      async tx => {
        let usageLogId: number | null = null
        {
          await this.usageService.chargeFixedModule(userId, "competitor.research", {
            quantity: new Set(dto.asins).size,
            model: billing.model,
            requestId: billing.requestId,
            meta: {
              phase: "summary",
              operation: "summary",
              businessEventId: dto.runId,
              country: dto.country,
              asins: dto.asins,
              actualCostCny: billing.costCny,
              gatewayRequestIds: billing.requestIds,
              tokenUsage,
            },
          }, tx)
          const usageLog = await tx.usageLog.findUnique({
            where: { requestId: billing.requestId },
            select: { id: true },
          })
          usageLogId = usageLog?.id ?? null
        }
        await tx.businessAiRun.updateMany({
          where: {
            userId,
            module: "competitor-analysis",
            operation: "summary",
            runId: dto.runId,
          },
          data: { status: "COMPLETED", usageLogId, error: null },
        })
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: COMPETITOR_TRANSACTION_MAX_WAIT_MS,
        timeout: COMPETITOR_TRANSACTION_TIMEOUT_MS,
      }
    )
  }

  private async _markSummaryRunFailed(
    userId: number,
    dto: SummarizeCompetitorsDto,
    error: unknown
  ): Promise<void> {
    if (!dto.runId) return
    await this.prisma.businessAiRun.updateMany({
      where: {
        userId,
        module: "competitor-analysis",
        operation: "summary",
        runId: dto.runId,
        status: "RUNNING",
      },
      data: {
        status: "FAILED",
        error: (error instanceof Error ? error.message : "竞品分析失败").slice(0, 1000),
      },
    })
  }

  private async _charge(
    userId: number,
    phase: "analyze" | "summary",
    country: string,
    asins: string[],
    gatewayResult: {
      billing?: AiGatewayBillingUsage
      tokenUsage: AiGatewayTokenUsage
    },
    businessEventId?: string
  ): Promise<void> {
    const billing = gatewayResult.billing
    if (!billing) throw new BadGatewayException("AI Gateway 未返回计费结果")
    await this.usageService.chargeFixedModule(userId, "competitor.research", {
      quantity: new Set(asins).size,
      model: billing.model,
      requestId: billing.requestId,
      meta: {
        phase,
        operation: phase,
        ...(businessEventId ? { businessEventId } : {}),
        country,
        asins,
        actualCostCny: billing.costCny,
        gatewayRequestIds: billing.requestIds,
        tokenUsage: gatewayResult.tokenUsage,
      },
    })
  }

  private async _analyzeModule(
    dto: AnalyzeCompetitorsDto,
    module: CompetitorAnalysisModuleId
  ): Promise<Record<string, unknown>> {
    const startedAt = new Date().toISOString()
    const evidence = await this.evidenceProvider.collectModuleEvidence(
      dto.country,
      dto.asins,
      module
    )
    const assembled = assembleCompetitorAnalysis(evidence)
    const sources = evidence.sources.map(source => ({ ...source, kind: "observed" }))
    const mcpUsage = {
      totalCalls: Object.values(evidence.callDetail).reduce((total, count) => total + count, 0),
      callDetail: evidence.callDetail,
    }

    if (module === "profile") {
      const profiles = this._normalizeProfiles(assembled.profiles, dto.asins)
      const items = this._buildItems(dto.asins, profiles, sources, "商品画像证据不足")
      return {
        ...this._buildModule(
          module,
          items,
          profiles,
          dto.country,
          startedAt,
          new Date().toISOString(),
          mcpUsage
        ),
        country: dto.country,
      }
    }

    if (module === "traffic") {
      const trafficBoards = this._normalizeTrafficBoards(assembled.trafficBoards, dto.asins)
      const items = this._buildItems(dto.asins, trafficBoards, sources, "流量与广告证据不足")
      return {
        ...this._buildModule(
          module,
          items,
          trafficBoards,
          dto.country,
          startedAt,
          new Date().toISOString(),
          mcpUsage
        ),
        country: dto.country,
      }
    }

    const pricePromoBoards = this._normalizePricePromoBoards(assembled.pricePromoBoards, dto.asins)
    const items = this._buildItems(dto.asins, pricePromoBoards, sources, "价格与促销证据不足")
    return {
      ...this._buildModule(
        module,
        items,
        pricePromoBoards,
        dto.country,
        startedAt,
        new Date().toISOString(),
        mcpUsage
      ),
      country: dto.country,
    }
  }

  private _buildSnapshot(
    dto: AnalyzeCompetitorsDto,
    evidence: CompetitorEvidenceBundle,
    assembled: AssembledCompetitorAnalysis,
    analysis: AiCompetitorAnalysis,
    startedAt: string
  ): Record<string, unknown> {
    const completedAt = new Date().toISOString()
    const sources = evidence.sources.map(source => ({ ...source, kind: "observed" }))
    const profiles = this._normalizeProfiles(assembled.profiles, dto.asins)
    const trafficBoards = this._normalizeTrafficBoards(assembled.trafficBoards, dto.asins)
    const pricePromoBoards = this._normalizePricePromoBoards(assembled.pricePromoBoards, dto.asins)
    const profileItems = this._buildItems(dto.asins, profiles, sources, "商品画像证据不足")
    const trafficItems = this._buildItems(dto.asins, trafficBoards, sources, "流量与广告证据不足")
    const pricePromoItems = this._buildItems(
      dto.asins,
      pricePromoBoards,
      sources,
      "价格与促销证据不足"
    )
    const modules = {
      profile: this._buildModule(
        "profile",
        profileItems,
        profiles,
        dto.country,
        startedAt,
        completedAt
      ),
      traffic: this._buildModule(
        "traffic",
        trafficItems,
        trafficBoards,
        dto.country,
        startedAt,
        completedAt
      ),
      pricePromo: this._buildModule(
        "pricePromo",
        pricePromoItems,
        pricePromoBoards,
        dto.country,
        startedAt,
        completedAt
      ),
    }
    const statuses = Object.fromEntries(
      dto.asins.map((asin, index) => [
        asin,
        {
          profile: profileItems[index],
          traffic: trafficItems[index],
          pricePromo: pricePromoItems[index],
        },
      ])
    )
    const usageTotal = Object.values(evidence.callDetail).reduce((total, count) => total + count, 0)
    const emptyUsage = { totalCalls: 0, callDetail: {} }

    return {
      version: 1,
      runId: randomUUID(),
      startedAt,
      completedAt,
      country: dto.country,
      capability: this._capabilityFor(dto.country),
      input: {
        competitors: dto.asins.map(asin => ({ asin })),
        acceptedAsins: dto.asins,
        lines: dto.asins.map((asin, index) => ({
          line: index + 1,
          raw: asin,
          asin,
          source: "asin",
          status: "valid",
          accepted: true,
          message: "",
        })),
        baselineAsin: null,
        hasBlockingIssue: false,
      },
      competitorAsins: dto.asins,
      modules,
      statuses,
      summary: this._normalizeSummary(analysis.summary, dto.asins),
      provenance: [
        ...sources,
        {
          provider: "ai_gateway",
          status: "used",
          kind: "inferred",
          label: "智擎 AI 中转站竞品分析",
        },
      ],
      usage: {
        total: { totalCalls: usageTotal, callDetail: evidence.callDetail },
        byModule: { profile: emptyUsage, traffic: emptyUsage, pricePromo: emptyUsage },
        byProvider: Object.fromEntries(
          Object.entries(evidence.callDetail).map(([provider, count]) => [
            provider,
            { totalCalls: count, callDetail: { [provider]: count } },
          ])
        ),
      },
    }
  }

  private _buildModule(
    module: "profile" | "traffic" | "pricePromo",
    items: ModuleItem[],
    data: Array<Record<string, unknown>>,
    country: string,
    startedAt: string,
    completedAt: string,
    mcpUsage: { totalCalls: number; callDetail: Record<string, number> } = {
      totalCalls: 0,
      callDetail: {},
    }
  ): Record<string, unknown> {
    const successfulItems = items.filter(item => item.status === "success")
    const key = module === "profile" ? "profiles" : "boards"
    return {
      module,
      status: successfulItems.length > 0 ? "success" : "unavailable",
      partial: successfulItems.length !== items.length,
      items,
      [key]: data.filter(item => item.found !== false),
      country,
      startedAt,
      completedAt,
      mcpUsage,
      sources: items.flatMap(item => item.sources),
      issues: items.flatMap(item => item.issues),
    }
  }

  private _buildItems(
    asins: string[],
    data: Array<Record<string, unknown>>,
    sources: Array<Record<string, unknown>>,
    unavailableMessage: string
  ): ModuleItem[] {
    const byAsin = new Map(data.map(item => [String(item.asin).toUpperCase(), item]))
    return asins.map(asin => {
      const item = byAsin.get(asin)
      const isAvailable = Boolean(item && item.found !== false)
      return {
        asin,
        status: isAvailable ? "success" : "unavailable",
        coverage: isAvailable ? "complete" : "none",
        data: item ?? null,
        sources,
        issues: isAvailable
          ? []
          : [{ code: "insufficient_evidence", message: unavailableMessage, source: "sif" }],
      }
    })
  }

  private _normalizeData(
    data: Array<Record<string, unknown>>,
    asins: string[]
  ): Array<Record<string, unknown>> {
    const accepted = new Set(asins)
    return data
      .filter(item => typeof item.asin === "string" && accepted.has(item.asin.toUpperCase()))
      .map(item => ({ ...item, asin: String(item.asin).toUpperCase() }))
  }

  private _normalizeProfiles(
    data: Array<Record<string, unknown>>,
    asins: string[]
  ): Array<Record<string, unknown>> {
    return this._normalizeData(data, asins).map(item => ({
      title: "",
      img: "",
      brand: "",
      price: null,
      score: null,
      ratingNum: null,
      boughtInPastMonth: null,
      mainBsr: null,
      listedDays: null,
      firstAvailableDay: null,
      variationNum: null,
      reviewGrowth30d: null,
      ...item,
      found: item.found !== false,
      specs: this._asArray(item.specs),
      bullets: this._asArray(item.bullets),
      salesTrend: this._asArray(item.salesTrend),
      priorityTags: this._asArray(item.priorityTags),
      exceptionTags: this._asArray(item.exceptionTags),
    }))
  }

  private _normalizeTrafficBoards(
    data: Array<Record<string, unknown>>,
    asins: string[]
  ): Array<Record<string, unknown>> {
    return this._normalizeData(data, asins).map(item => {
      const asin = String(item.asin)
      const summary = this._asRecord(item.summary)
      const adDetail = this._asRecord(item.adDetail)
      const keywords = this._normalizeKeywordRows(item.keywords)
      const adGroups = this._asArray(adDetail.groups).map(value => {
        const group = this._asRecord(value)
        return {
          root: "未分组",
          keywordCount: 0,
          structure: "样本不足",
          targeting: "样本不足",
          matchMode: "样本不足",
          confidence: "insufficient",
          reason: "证据不足",
          ...group,
          keywords: this._asArray(group.keywords),
        }
      })
      const campaigns = this._asArray(adDetail.campaigns).map(value => {
        const campaign = this._asRecord(value)
        const groups = this._asArray(campaign.groups).map(groupValue => {
          const group = this._asRecord(groupValue)
          return {
            adGroupId: "未识别广告组",
            matchMode: "样本不足",
            structure: "样本不足",
            keywordCount: 0,
            adScore: 0,
            sharePct: 0,
            ...group,
            keywordTrend: this._asArray(group.keywordTrend),
          }
        })
        return { ...campaign, groups }
      })
      return {
        ...item,
        found: summary.found !== false,
        summary: {
          asin,
          found: summary.found !== false,
          totalScore: null,
          totalScoreChg: null,
          naturalRatio: null,
          adRatio: null,
          adKeywordNum: null,
          campaignCnt: null,
          spKeywordNum: null,
          sbKeywordNum: null,
          sbvKeywordNum: null,
          naturalKeywordNumIn: null,
          naturalKeywordNumOut: null,
          adKeywordNumIn: null,
          adKeywordNumOut: null,
          adScoreChg: null,
          ...summary,
        },
        keywords,
        adDetail: {
          asin,
          keywordCount: 0,
          campaignCountEstimate: 0,
          adGroupCountEstimate: 0,
          primaryTargeting: null,
          alternativeTargeting: null,
          confidence: "low",
          notice: "",
          ...adDetail,
          groups: adGroups,
          campaigns,
          keywords: this._normalizeKeywordRows(adDetail.keywords),
        },
      }
    })
  }

  private _normalizePricePromoBoards(
    data: Array<Record<string, unknown>>,
    asins: string[]
  ): Array<Record<string, unknown>> {
    return this._normalizeData(data, asins).map(item => {
      const asin = String(item.asin)
      const series = this._asRecord(item.series)
      const metrics = this._asRecord(item.metrics)
      const sop = this._asRecord(item.sop)
      const timeline = this._asArray(item.timeline).map(value => {
        const row = this._asRecord(value)
        const priceSignal = this._asRecord(row.priceSignal)
        const bsrEffect = this._asRecord(row.bsrEffect)
        const isPriceSignalValid =
          ["down", "up", "flat"].includes(String(priceSignal.dir)) &&
          this._isFiniteNumber(priceSignal.from) &&
          this._isFiniteNumber(priceSignal.to)
        const isBsrEffectValid =
          this._isFiniteNumber(bsrEffect.from) &&
          this._isFiniteNumber(bsrEffect.to) &&
          this._isFiniteNumber(bsrEffect.delta)
        return {
          ...row,
          priceSignal: isPriceSignalValid ? priceSignal : null,
          extraSignals: this._asArray(row.extraSignals).filter(
            signal => typeof signal === "string"
          ),
          actions: this._asArray(row.actions)
            .map(action => this._asRecord(action))
            .filter(
              action =>
                typeof action.label === "string" &&
                ["ad", "promo", "listing", "price", "review"].includes(String(action.type))
            ),
          bsrEffect: isBsrEffectValid ? bsrEffect : null,
        }
      })
      const channels = this._asArray(series.channels).map(value => {
        const channel = this._asRecord(value)
        return {
          ...channel,
          points: this._normalizeSeriesPoints(channel.points),
        }
      })
      return {
        currentPrice: null,
        buyBoxSeller: null,
        verdict: "证据不足",
        coldStartNote: null,
        ...item,
        found: item.found !== false,
        timeline,
        verdictTags: this._asArray(item.verdictTags),
        series: {
          startDate: null,
          endDate: null,
          source: "sif",
          sourceState: "unavailable",
          ...series,
          channels,
          salesRank: this._normalizeSeriesPoints(series.salesRank),
        },
        metrics: {
          currentPrice: null,
          priceVolatility: "unknown",
          promoCount30d: null,
          bsrFrom: null,
          bsrTo: null,
          bsrDelta: null,
          reviewGrowth30d: null,
          ...metrics,
          topKeywords: this._asArray(metrics.topKeywords),
        },
        sop: {
          asin,
          stage: "证据不足",
          grain: "week",
          listedDays: null,
          earlyStageNote: null,
          salesTrendPct: null,
          bsrTrendPct: null,
          ...sop,
          weeks: this._asArray(sop.weeks),
          rows: this._asArray(sop.rows),
        },
      }
    })
  }

  private _normalizeSummary(
    summary: AiCompetitorAnalysis["summary"],
    asins: string[]
  ): AiCompetitorAnalysis["summary"] {
    const kinds = ["landscape", "threat", "opportunity", "action"]
    const insightsByKind = new Map(summary.insights.map(insight => [insight.kind, insight]))
    const rankingsByAsin = new Map(
      summary.rankings
        .filter(
          ranking => typeof ranking.asin === "string" && asins.includes(ranking.asin.toUpperCase())
        )
        .map(ranking => [String(ranking.asin).toUpperCase(), ranking])
    )
    return {
      insights: kinds.map(kind => {
        const insight = insightsByKind.get(kind)
        const evidence = this._asArray(insight?.evidence)
          .map(value => this._asRecord(value))
          .filter(
            item =>
              typeof item.asin === "string" &&
              typeof item.metric === "string" &&
              typeof item.label === "string" &&
              (typeof item.value === "string" || this._isFiniteNumber(item.value))
          )
        return {
          kind,
          status: "insufficient",
          title: "AI 总结待重试",
          description:
            "事实数据已正常加载，但 AI 未返回该项的有效总结；这不代表事实数据不足，请重新分析。",
          severity: "low",
          confidence: "insufficient",
          ...(insight ?? {}),
          method: "ai_generated",
          evidence,
        }
      }),
      rankings: asins.map(asin => ({
        rank: null,
        relativePressureScore: null,
        evidenceCoverage: 0,
        price: null,
        monthlySales: null,
        trafficScore: null,
        adRatio: null,
        bsrDelta: null,
        reviewGrowth30d: null,
        ...(rankingsByAsin.get(asin) ?? {}),
        asin,
      })),
    }
  }

  private _asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }

  private _asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? (value as unknown[]) : []
  }

  private _normalizeSeriesPoints(value: unknown): Array<Record<string, unknown>> {
    return this._asArray(value)
      .map(item => this._asRecord(item))
      .filter(
        item =>
          typeof item.date === "string" &&
          typeof item.value === "number" &&
          Number.isFinite(item.value)
      )
  }

  private _normalizeKeywordRows(value: unknown): Array<Record<string, unknown>> {
    return this._asArray(value)
      .map(item => this._asRecord(item))
      .filter(item => typeof item.keyword === "string" && item.keyword.trim().length > 0)
      .map(item => ({
        ...item,
        keyword: String(item.keyword).trim(),
        searchVolume: this._asFiniteNumber(item.searchVolume, 0),
        totalScoreRatio: this._asNullableFiniteNumber(item.totalScoreRatio),
        adScoreRatio: this._asFiniteNumber(item.adScoreRatio, 0),
        spRank: typeof item.spRank === "string" ? item.spRank : null,
        naturalRank: typeof item.naturalRank === "string" ? item.naturalRank : null,
        marketConversionRate: this._asNullableFiniteNumber(item.marketConversionRate),
        listingAdScoreRatio: this._asFiniteNumber(item.listingAdScoreRatio, 0),
        adRatioRising: item.adRatioRising === true,
        fieldSources: this._asRecord(item.fieldSources),
      }))
  }

  private _asFiniteNumber(value: unknown, fallback: number): number {
    return this._isFiniteNumber(value) ? value : fallback
  }

  private _asNullableFiniteNumber(value: unknown): number | null {
    return this._isFiniteNumber(value) ? value : null
  }

  private _isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value)
  }

  private _isAnalysisComplete(value: unknown): boolean {
    const root = this._asRecord(value)
    const summary = this._getAnalysisSummary(root)
    return Array.isArray(summary.insights) && Array.isArray(summary.rankings)
  }

  private _normalizeAnalysis(value: unknown): AiCompetitorAnalysis {
    const root = this._asRecord(value)
    const summary = this._getAnalysisSummary(root)
    const hasSummary =
      Boolean(root.summary && typeof root.summary === "object" && !Array.isArray(root.summary)) ||
      summary === root
    const hasInsights = Array.isArray(summary.insights)
    const hasRankings = Array.isArray(summary.rankings)

    if (!hasSummary || !hasInsights || !hasRankings) {
      this.logger.warn(
        `AI 中转站返回的竞品分析结构不完整，已使用 AI 总结待重试兜底 summary=${hasSummary} insights=${hasInsights} rankings=${hasRankings}`
      )
    }

    return {
      summary: {
        insights: this._asArray(summary.insights)
          .map(item => this._asRecord(item))
          .filter(item => Object.keys(item).length > 0),
        rankings: this._asArray(summary.rankings)
          .map(item => this._asRecord(item))
          .filter(item => Object.keys(item).length > 0),
      },
    }
  }

  private _getAnalysisSummary(root: Record<string, unknown>): Record<string, unknown> {
    const nestedSummary = this._asRecord(root.summary)
    if (Object.keys(nestedSummary).length > 0) return nestedSummary

    const hasDirectSummary = Array.isArray(root.insights) || Array.isArray(root.rankings)
    return hasDirectSummary ? root : nestedSummary
  }

  private _capabilityFor(country: string): MarketplaceCapability {
    const [label, flag, currency, locale, domain] = MARKET_META[country]
    return {
      marketplace: country,
      label,
      flag,
      currency,
      locale,
      sif: { status: "supported" },
      profile: { status: "supported" },
      traffic: { status: "supported" },
      pricePromo: { status: "supported" },
      keepaHistory: { status: domain ? "supported" : "not_supported", domain },
    }
  }
}
