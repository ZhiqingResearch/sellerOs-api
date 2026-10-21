import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Interval } from "@nestjs/schedule"
import { Prisma } from "@prisma/client"
import { createHash, randomUUID } from "crypto"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { canonicalJson } from "../product-selection/canonical-json"
import { UsageService } from "../usage/usage.service"
import { CATEGORY_ANALYSIS_SYSTEM_PROMPT } from "./category-analysis.prompt"
import { buildReads, calculateStatistics } from "./category-analysis.statistics"
import type {
  CategoryAnalysisInput,
  CategoryCandidate,
  CategoryEvidence,
  CategoryReport,
  CategorySelection,
  KeywordResolution,
} from "./category-analysis.types"
import { CategoryEvidenceProvider, type CategoryDataUsage } from "./category-evidence.provider"
import { parseSampleFile } from "./category-sample.parser"
import type {
  CreateCategoryAnalysisDto,
  ImportCategorySampleDto,
  QueryCategoryAnalysisDto,
} from "./dto/create-category-analysis.dto"

import { focusEvidence, keywordConsistency } from "./category-enrichment"

const LEASE_MS = 40 * 60 * 1000
const REPORT_ATTEMPTS = 2
const SECTION_TITLES = ["核心结论", "准入风险", "市场容量", "竞争格局", "头部动态", "切入机会"]

export function validateReportMarkdown(markdown: string, advice: string): boolean {
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)].map(match => match[1].trim())
  return (
    markdown.length > 100 &&
    headings.join("|") === SECTION_TITLES.join("|") &&
    markdown.includes(advice) &&
    /^###\s+数据核对\s*$/m.test(markdown) &&
    !/放弃|止损|淘汰|红线|一票否决|必死|稳赚|闭眼入|\bSIF\b|\bKeepa\b|卖家精灵|ABA\s*接口|演示数据|cap_score|comp_score|entry_score|综合分\s*\d/i.test(
      markdown
    )
  )
}

@Injectable()
export class CategoryAnalysisService {
  private readonly logger = new Logger(CategoryAnalysisService.name)
  private isWorking = false
  constructor(
    private readonly prisma: PrismaService,
    private readonly evidence: CategoryEvidenceProvider,
    private readonly gateway: AiGatewayProvider,
    private readonly usage: UsageService,
    private readonly config: ConfigService
  ) {}

  async create(userId: number, dto: CreateCategoryAnalysisDto) {
    const categories = dto.categories.map(category => ({
      nodeId: category.nodeId.trim(),
      nodeIdPath: category.nodeIdPath.trim(),
      path: category.path.trim(),
      name: category.name.trim(),
      ...(category.seedKeyword?.trim() ? { seedKeyword: category.seedKeyword.trim() } : {}),
      ...(category.parentName?.trim() ? { parentName: category.parentName.trim() } : {}),
      ...(category.categoryId ? { categoryId: category.categoryId } : {}),
      ...(category.from ? { from: category.from } : {}),
      ...(category.resolvedFrom ? { resolvedFrom: category.resolvedFrom } : {}),
    }))
    if (
      categories.some(
        category => !category.nodeId || !category.path || !category.name || !category.nodeIdPath
      ) ||
      new Set(categories.map(category => category.nodeId)).size !== categories.length
    )
      throw new BadRequestException("类目不能为空或重复")
    const keywords = [
      ...new Set(
        (dto.keywords ?? [])
          .map(value => value.trim().toLowerCase().replace(/\s+/g, " "))
          .filter(Boolean)
      ),
    ]
    const plan = dto.plan ?? "cat"
    if (keywords.length > 5 || categories.length > 5 || (!categories.length && !keywords.length))
      throw new BadRequestException("请选择类目或输入英文关键词，类目和关键词各最多 5 个")
    if (keywords.some(keyword => /[\u4e00-\u9fa5]/.test(keyword) || keyword.length > 200))
      throw new BadRequestException(
        "请使用英文关键词，例如耳机可输入 earbuds；每个词不超过 200 字符"
      )
    if (plan !== "cat" && !keywords.length) throw new BadRequestException("请先输入关键词")
    const fingerprint = createHash("sha256")
      .update(
        canonicalJson({
          marketplace: dto.marketplace,
          categories,
          ...(keywords.length ? { keywords, plan } : {}),
        })
      )
      .digest("hex")
    const findExisting = () =>
      this.prisma.categoryAnalysisRecord.findUnique({
        where: { userId_requestId: { userId, requestId: dto.requestId } },
      })
    const resolveExisting = (record: NonNullable<Awaited<ReturnType<typeof findExisting>>>) => {
      if (record.fingerprint !== fingerprint || record.deletedAt)
        throw new ConflictException("请求编号已用于其他分析，请重新提交")
      return this._summary(record)
    }
    const existing = await findExisting()
    if (existing) return resolveExisting(existing)
    if (!this.config.get<string>("AI_GATEWAY_API_KEY")?.trim())
      throw new BadRequestException("报告解读服务尚未配置，请联系管理员")
    await this.usage.assertFixedModuleAffordable(userId, "category.analysis", undefined, undefined,
      plan === "kw" ? 1 : Math.max(1, categories.length))
    try {
      // 提交只创建任务；全部报告成功后统一结算。
      const record = await this.prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT id FROM User WHERE id = ${userId} FOR UPDATE`
          const duplicate = await tx.categoryAnalysisRecord.findUnique({
            where: { userId_requestId: { userId, requestId: dto.requestId } },
          })
          if (duplicate) {
            resolveExisting(duplicate)
            return duplicate
          }
          return tx.categoryAnalysisRecord.create({
            data: {
              userId,
              requestId: dto.requestId,
              fingerprint,
              marketplace: dto.marketplace,
              keywords,
              plan,
              title: (categories.length
                ? categories.map(category => category.path.split(/\s*>\s*/).at(-1)).join("、")
                : keywords.join("、")
              ).slice(0, 500),
              categories: JSON.parse(JSON.stringify(categories)) as Prisma.InputJsonValue,
              credits: 0,
            },
          })
        },
        { timeout: 30000 }
      )
      void this.processQueue().catch(() => this.logger.warn("类目分析任务等待下一轮调度"))
      return resolveExisting(record)
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const record = await findExisting()
        if (record) return resolveExisting(record)
      }
      throw error
    }
  }

  async findAll(userId: number, query: QueryCategoryAnalysisDto) {
    const page = query.page ?? 1,
      pageSize = query.pageSize ?? 20
    const where = {
      userId,
      deletedAt: null,
      ...(query.keyword ? { title: { contains: query.keyword } } : {}),
    }
    const [items, total] = await Promise.all([
      this.prisma.categoryAnalysisRecord.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          title: true,
          marketplace: true,
          status: true,
          credits: true,
          error: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.categoryAnalysisRecord.count({ where }),
    ])
    return { items, total, page, pageSize }
  }
  async findOne(userId: number, id: number) {
    const record = await this.prisma.categoryAnalysisRecord.findFirst({
      where: { id, userId, deletedAt: null },
    })
    if (!record) throw new NotFoundException("类目分析记录不存在")
    const refundLog = await this.prisma.usageLog.findFirst({
      where: {
        userId,
        source: "category.analysis",
        AND: [
          { meta: { path: "$.analysisId", equals: id } },
          { meta: { path: "$.refundedCredits", not: Prisma.AnyNull } },
        ],
      },
      select: { meta: true },
    })
    const refundMeta = refundLog?.meta
    const refundValue =
      refundMeta && typeof refundMeta === "object" && !Array.isArray(refundMeta)
        ? refundMeta.refundedCredits
        : null
    const refundedCredits =
      typeof refundValue === "string" || typeof refundValue === "number" ? String(refundValue) : "0"
    return {
      ...this._summary(record),
      refundedCredits,
      categories: record.categories,
      keywords: record.keywords ?? [],
      plan: record.plan,
      resolution: record.resolution,
      reports: record.result ?? [],
    }
  }
  async remove(userId: number, id: number) {
    const record = await this.findOne(userId, id)
    if (["PENDING", "PROCESSING"].includes(record.status))
      throw new BadRequestException("分析进行中，暂不能删除")
    await this.prisma.categoryAnalysisRecord.updateMany({
      where: {
        id,
        userId,
        deletedAt: null,
        status: { in: ["COMPLETED", "FAILED", "AWAITING_SELECTION"] },
      },
      data: { deletedAt: new Date() },
    })
    return { success: true }
  }
  private _candidateSelection(candidate: CategoryCandidate): CategorySelection {
    return {
      nodeId: candidate.categoryId,
      nodeIdPath: candidate.categoryId,
      categoryId: candidate.categoryId,
      name: candidate.categoryName,
      path: candidate.categoryName,
      seedKeyword: candidate.kws[0],
      from: "keyword",
      resolvedFrom: candidate.kws,
    }
  }

  async confirmCandidates(userId: number, id: number, categoryIds: string[]) {
    const record = await this.prisma.categoryAnalysisRecord.findFirst({
      where: { id, userId, deletedAt: null },
    })
    if (!record) throw new NotFoundException("类目分析记录不存在")
    const resolution = record.resolution as unknown as KeywordResolution | null
    if (
      !categoryIds.length ||
      categoryIds.length > 5 ||
      new Set(categoryIds).size !== categoryIds.length ||
      categoryIds.some(id => !resolution?.candidates.some(candidate => candidate.categoryId === id))
    )
      throw new BadRequestException("请从候选列表选择 1 至 5 个类目")
    if (record.status !== "AWAITING_SELECTION") {
      if (
        resolution?.confirmedIds?.slice().sort().join(",") === categoryIds.slice().sort().join(",")
      )
        return this.findOne(userId, id)
      throw new ConflictException("候选类目已确认，请勿重复修改")
    }
    const categories = categoryIds.map(id =>
      this._candidateSelection(
        resolution!.candidates.find(candidate => candidate.categoryId === id)!
      )
    )
    await this.usage.assertFixedModuleAffordable(userId, "category.analysis", undefined, undefined, categories.length)
    const updated = await this.prisma.categoryAnalysisRecord.updateMany({
      where: { id, userId, deletedAt: null, status: "AWAITING_SELECTION" },
      data: {
        categories: JSON.parse(JSON.stringify(categories)) as Prisma.InputJsonValue,
        resolution: JSON.parse(
          JSON.stringify({ ...resolution, confirmedIds: categoryIds })
        ) as Prisma.InputJsonValue,
        title: categories
          .map(category => category.name)
          .join("、")
          .slice(0, 500),
        status: "PENDING",
        plan: "kw",
      },
    })
    if (!updated.count) throw new ConflictException("候选类目已确认，请刷新查看")
    void this.processQueue().catch(() => this.logger.warn("关键词类目任务等待下一轮调度"))
    return this.findOne(userId, id)
  }

  async importSample(
    userId: number,
    dto: ImportCategorySampleDto,
    file: { buffer: Buffer; originalname: string } | undefined
  ) {
    if (!file) throw new BadRequestException("请选择样本文件")
    const sample = parseSampleFile(file.buffer, file.originalname)
    await this.prisma.categoryAnalysisSample.upsert({
      where: {
        userId_categoryId_marketplace_month: {
          userId,
          categoryId: dto.categoryId,
          marketplace: dto.marketplace,
          month: sample.month,
        },
      },
      create: {
        userId,
        categoryId: dto.categoryId,
        marketplace: dto.marketplace,
        month: sample.month,
        rows: JSON.parse(JSON.stringify(sample.rows)) as Prisma.InputJsonValue,
      },
      update: { rows: JSON.parse(JSON.stringify(sample.rows)) as Prisma.InputJsonValue },
    })
    return { month: sample.month, listingCount: sample.rows.length }
  }

  @Interval(5000)
  async processQueue(): Promise<void> {
    if (this.isWorking) return
    this.isWorking = true
    try {
      await this.prisma.categoryAnalysisRecord.updateMany({
        where: { status: "PROCESSING", leaseExpiresAt: { lt: new Date() } },
        data: {
          status: "FAILED",
          error: "分析执行中断，请稍后重新发起",
          leaseToken: null,
          leaseExpiresAt: null,
        },
      })
      const record = await this.prisma.categoryAnalysisRecord.findFirst({
        where: { status: "PENDING", deletedAt: null },
        orderBy: { createdAt: "asc" },
      })
      if (!record) return
      const leaseToken = randomUUID()
      const claim = await this.prisma.categoryAnalysisRecord.updateMany({
        where: { id: record.id, status: "PENDING" },
        data: { status: "PROCESSING", leaseToken, leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
      })
      if (!claim.count) return
      const reports: CategoryReport[] = []
      try {
        const keywords = (record.keywords ?? []) as string[]
        let resolution = record.resolution as unknown as KeywordResolution | null
        const categories = record.categories as unknown as CategorySelection[]
        if (keywords.length && !resolution) {
          const resolutionUsage: CategoryDataUsage = {
            totalCalls: 0,
            callDetail: {},
            endpointCalls: {},
          }
          resolution = await this.evidence.resolveKeywords(keywords, record.marketplace, resolutionUsage)
          const needsSelection = !categories.length || record.plan === "kw"
          if (needsSelection && !resolution.candidates.length)
            throw new BadGatewayException("未找到可用的候选类目，请检查英文拼写或换一个关键词")
          const saved = await this.prisma.categoryAnalysisRecord.updateMany({
            where: {
              id: record.id,
              status: "PROCESSING",
              leaseToken,
              leaseExpiresAt: { gt: new Date() },
            },
            data: {
              resolution: JSON.parse(JSON.stringify(resolution)) as Prisma.InputJsonValue,
              ...(needsSelection
                ? { status: "AWAITING_SELECTION", leaseToken: null, leaseExpiresAt: null }
                : {}),
            },
          })
          if (!saved.count) throw new ConflictException("分析任务执行权已失效")
          if (needsSelection) return
        }
        if (record.plan === "kw" && !resolution?.confirmedIds?.length) {
          if (!resolution?.candidates.length)
            throw new BadGatewayException("关键词未定位到可用类目，请调整关键词")
          // 已定位但未确认的任务也必须让用户看到总价并选择，不能自动扩大扣费数量。
          await this.prisma.categoryAnalysisRecord.updateMany({
            where: { id: record.id, status: "PROCESSING", leaseToken, leaseExpiresAt: { gt: new Date() } },
            data: { status: "AWAITING_SELECTION", leaseToken: null, leaseExpiresAt: null },
          })
          return
        }
        await this.usage.assertFixedModuleAffordable(record.userId, "category.analysis", undefined, undefined, categories.length)
        for (const category of categories) {
          const dataUsage: CategoryDataUsage = { totalCalls: 0, callDetail: {}, endpointCalls: {} }
          let evidence: CategoryEvidence = await this.evidence.collect(
            record.userId, category, record.marketplace, dataUsage, keywords
          )
          const consistency = resolution ? keywordConsistency(evidence, resolution) : null
          let effectivePlan = record.plan as "cat" | "kw" | "mix"
          let focusRows: number | null = null
          if (record.plan === "mix") {
            const focused = focusEvidence(evidence, keywords)
            focusRows = focused.count
            evidence = focused.evidence
            if (focused.isFallback) {
              effectivePlan = "cat"
              evidence.notices.push(
                `标题命中的交集仅 ${focusRows} 条，不足 30 条，已按完整类目样本分析`
              )
            }
          }
          evidence.notices.push(...(resolution?.notices ?? []))
          const reportCategory =
            effectivePlan === "mix"
              ? { ...category, path: `${category.path} ∩ ${keywords.join("/")}` }
              : category
          const input = calculateStatistics(reportCategory, record.marketplace, evidence)
          if (keywords.length)
            input.user_keywords = {
              list: keywords,
              plan: effectivePlan,
              consistent: consistency?.consistent ?? null,
              asin_overlap: consistency?.overlap ?? null,
              top_category: resolution?.candidates[0]?.categoryName ?? null,
              focus_rows: focusRows,
            }
          const markdown = await this._generateReport(input)
          reports.push({
            categoryId: category.nodeId,
            input,
            reads: buildReads(input),
            markdown,
            notices: evidence.notices,
          })
          reports.sort((a, b) => b.input.diag.score - a.input.diag.score)
          await this._saveProgress(record.id, record.userId, leaseToken, reports)
        }
        await this._saveProgress(record.id, record.userId, leaseToken, reports, "COMPLETED")
      } catch (error) {
        const message =
          error instanceof HttpException ? error.message : "分析服务暂不可用，请稍后重试"
        await this._saveProgress(record.id, record.userId, leaseToken, reports, "FAILED", message)
        this.logger.warn(`类目分析失败 id=${record.id}`)
      }
    } finally {
      this.isWorking = false
    }
  }
  private async _generateReport(
    input: CategoryAnalysisInput
  ): Promise<string> {
    // 历史报告兼容字段留在存储层，给模型的协议只使用最新版字段。
    const promptJson = JSON.stringify(input, (key: string, value: unknown) =>
      ["keepa", "listing_bar"].includes(key) ? undefined : value
    )
    const message = `请按系统提示词的规则与输出格式，为以下类目生成类目分析报告。\n只用 JSON 里的数据；null 写「需补充」；不写数据来源；不输出内部分数。\n<input>\n${promptJson}\n</input>`
    for (let attempt = 0; attempt < REPORT_ATTEMPTS; attempt++) {
      let markdown = ""
      let hasBilling = false
      const instruction = attempt
        ? "\n上次输出没有通过格式校验。请重新按原始数据生成完整报告：只使用六个规定的二级标题，末尾保留三级标题「数据核对」，不要加代码围栏、来源名、内部分数或禁用判断词。"
        : ""
      for await (const event of this.gateway.streamChat(
        CATEGORY_ANALYSIS_SYSTEM_PROMPT,
        message + instruction,
        {
          modelConfigKey: "AI_GATEWAY_CATEGORY_ANALYSIS_MODEL",
          temperature: 0.2,
          operationName: "类目分析报告",
          resolveBilling: true,
        }
      )) {
        if (event.type === "text") markdown += event.content
        if (event.type === "billing" && event.billing) {
          hasBilling = true
        }
      }
      if (!hasBilling) throw new BadGatewayException("AI 账单尚未确认，本次 AI 调用未扣积分")
      if (validateReportMarkdown(markdown, input.diag.advice)) return markdown
    }
    throw new BadGatewayException("报告未能按要求生成，请稍后重新分析")
  }

  private async _saveProgress(
    id: number,
    userId: number,
    leaseToken: string,
    reports: CategoryReport[],
    status: "PROCESSING" | "COMPLETED" | "FAILED" = "PROCESSING",
    error?: string
  ): Promise<void> {
    await this.prisma.$transaction(
      async tx => {
        const updated = await tx.categoryAnalysisRecord.updateMany({
          where: {
            id,
            userId,
            status: "PROCESSING",
            leaseToken,
            leaseExpiresAt: { gt: new Date() },
          },
          data: {
            status,
            result: JSON.parse(JSON.stringify(reports)) as Prisma.InputJsonValue,
            ...(error ? { error: error.slice(0, 500) } : {}),
            ...(status === "PROCESSING"
              ? { leaseExpiresAt: new Date(Date.now() + LEASE_MS) }
              : { leaseToken: null, leaseExpiresAt: null }),
          },
        })
        if (!updated.count) throw new ConflictException("分析任务执行权已失效")
        if (status === "COMPLETED") {
          const charge = await this.usage.chargeFixedModule(userId, "category.analysis", {
            model: "fixed-module", requestId: `category-analysis:${userId}:${id}`,
            quantity: reports.length,
            meta: { operation: "analysis", analysisId: id },
          }, tx)
          await tx.categoryAnalysisRecord.update({ where: { id }, data: { credits: charge.creditsCharged } })
        }
      },
      { timeout: 30000 }
    )
  }
  private _summary(record: {
    id: number
    title: string
    marketplace: string
    status: string
    credits: Prisma.Decimal
    error: string | null
    createdAt: Date
    updatedAt: Date
  }) {
    return {
      id: record.id,
      title: record.title,
      marketplace: record.marketplace,
      status: record.status,
      credits: record.credits,
      error: record.error,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }
}
