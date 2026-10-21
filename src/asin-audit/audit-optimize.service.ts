import { Injectable, Logger } from "@nestjs/common"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { AsinAuditBilling } from "./asin-audit.billing"
import type { AsinAuditSseEvent } from "./asin-audit.types"
import { asinAuditActionLabel } from "./asin-audit.types"
import type { OptimizeRequestDto } from "./dto/optimize.dto"
import { buildAsinAuditOptimizeUserPrompt } from "./prompts/asin-audit-optimize"
import { modelResponseLanguageDirective } from "./prompts/model-response-language"
import { buildAsinAuditOptimizeSkill } from "./prompts/skill-assembler"
import { extractJson, parseLlmJson } from "./rules/extract-json"
import { filterForbiddenKeywords } from "./rules/forbidden-words"
import { normalizeAuditEvidence } from "./rules/normalize-evidence"
import type {
  AplusModule,
  AuditEvidence,
  AuditFieldRewrite,
  AuditImprovementPriority,
  AuditOptimizeListing,
  AuditOptimizeResult,
  AuditScoreResult,
  DeEvidenceResult,
  DifferentiationUSP,
  ImageSellingPoint,
  KeywordTier,
  LaunchPhase,
  ReviewResponseStrategy,
} from "./types/audit.types"
import type { Market } from "./types/scout.types"

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

const optimizeLogger = new Logger("AuditOptimizeService")

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === "string")
    .map(s => s.trim())
    .filter(Boolean)
}

function parseListing(v: unknown): AuditOptimizeListing {
  const rec = (v && typeof v === "object" ? v : {}) as Record<string, unknown>
  const qa: { q: string; a: string }[] = []
  if (Array.isArray(rec.qaCandidates)) {
    for (const item of rec.qaCandidates) {
      if (!item || typeof item !== "object") continue
      const r = item as Record<string, unknown>
      const q = asString(r.q)
      const a = asString(r.a)
      if (q && a) qa.push({ q, a })
    }
  }
  return {
    title: asString(rec.title),
    bullets: asStringArray(rec.bullets),
    description: asString(rec.description),
    searchTerms: asStringArray(rec.searchTerms),
    qaCandidates: qa,
  }
}

function parseImageSellingPoints(v: unknown): ImageSellingPoint[] {
  if (!Array.isArray(v)) return []
  const out: ImageSellingPoint[] = []
  for (const item of v) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    const name = asString(r.name)
    const description = asString(r.description)
    if (!name && !description) continue
    out.push({ type: asString(r.type), name, description })
  }
  return out
}

function parseAplusModules(v: unknown): AplusModule[] {
  if (!Array.isArray(v)) return []
  const out: AplusModule[] = []
  for (const item of v) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    const name = asString(r.name)
    const description = asString(r.description)
    if (!name && !description) continue
    out.push({ name, nameEn: asString(r.nameEn), description })
  }
  return out
}

const TIER_VALUES: KeywordTier["tier"][] = ["S", "A", "B", "longtail"]

function parseKeywordTiers(v: unknown): KeywordTier[] {
  if (!Array.isArray(v)) return []
  const out: KeywordTier[] = []
  for (const item of v) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    const rawTier = asString(r.tier)
    const tier = (TIER_VALUES as string[]).includes(rawTier)
      ? (rawTier as KeywordTier["tier"])
      : "longtail"
    const keywords = asStringArray(r.keywords)
    out.push({ tier, label: asString(r.label), keywords })
  }
  return out
}

function parseReviewStrategies(v: unknown): ReviewResponseStrategy[] {
  if (!Array.isArray(v)) return []
  const out: ReviewResponseStrategy[] = []
  for (const item of v) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    const painPoint = asString(r.painPoint)
    if (!painPoint) continue
    out.push({
      painPoint,
      response: asString(r.response),
      improvement: asString(r.improvement),
    })
  }
  return out
}

function parseDifferentiationUSPs(v: unknown): DifferentiationUSP[] {
  if (!Array.isArray(v)) return []
  const out: DifferentiationUSP[] = []
  for (const item of v) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    const title = asString(r.title)
    if (!title) continue
    out.push({ title, analysis: asString(r.analysis) })
  }
  return out
}

function parseLaunchPhases(v: unknown): LaunchPhase[] {
  if (!Array.isArray(v)) return []
  const out: LaunchPhase[] = []
  for (const item of v) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    const name = asString(r.name)
    if (!name) continue
    out.push({
      name,
      timeline: asString(r.timeline),
      goal: asString(r.goal),
      tactics: asStringArray(r.tactics),
    })
  }
  return out
}

function parseFieldRewrites(v: unknown): AuditFieldRewrite[] {
  if (!Array.isArray(v)) return []
  const out: AuditFieldRewrite[] = []
  for (const item of v) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    const field = asString(r.field)
    const rewritten = asString(r.rewritten)
    if (!field || !rewritten) continue
    out.push({
      field,
      original: asString(r.original),
      rewritten,
      reason: asString(r.reason),
    })
  }
  return out
}

const PRIORITY_LEVELS: AuditImprovementPriority["level"][] = ["P0", "P1", "P2", "P3"]

function parseImprovementPriorities(v: unknown): AuditImprovementPriority[] {
  if (!Array.isArray(v)) return []
  const out: AuditImprovementPriority[] = []
  for (const item of v) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    const rawLevel = asString(r.level).toUpperCase()
    const level = (PRIORITY_LEVELS as string[]).includes(rawLevel)
      ? (rawLevel as AuditImprovementPriority["level"])
      : "P2"
    const title = asString(r.title)
    const action = asString(r.action)
    if (!title && !action) continue
    out.push({
      level,
      title,
      impact: asString(r.impact),
      effort: asString(r.effort),
      action,
    })
  }
  return out
}

function firstListingTitle(evidence: AuditEvidence): string {
  return asString(evidence.A?.title) || `ASIN ${evidence.asin}`
}

/** 关键词数组清洗（禁词红线机械层）：剔除确定性禁词并告警，kept 保持原顺序。 */
function cleanKeywordList(terms: string[]): string[] {
  const { kept, dropped } = filterForbiddenKeywords(terms)
  if (dropped.length) {
    optimizeLogger.warn(
      `优化交付物命中禁词已剔除 ${dropped.length} 个：${dropped.map(d => `${d.kw}（${d.reason}）`).join("；")}`
    )
  }
  return kept
}

function fallbackSearchTerms(evidence: AuditEvidence): string[] {
  const terms = new Set<string>()
  for (const row of evidence.D?.kwTop ?? []) {
    const kw = asString((row as unknown as Record<string, unknown>).kw)
    if (kw) terms.add(kw)
  }
  for (const kw of evidence.C?.sharedKeywords ?? []) {
    if (kw) terms.add(kw)
  }
  for (const item of evidence.C?.keywords ?? []) {
    if (item.kw) terms.add(item.kw)
  }
  // 禁词红线：查询词先过三类禁词过滤（促销词/商标符/静态竞品品牌词，兼容前缀除外）再取前 14
  const { kept } = filterForbiddenKeywords(Array.from(terms))
  return kept.slice(0, 14)
}

function scorePriorityFallback(score: AuditScoreResult, index: number): AuditImprovementPriority {
  // v2.0：按十板块项目的「已核验失分」降序生成兜底优先级（P0–P3 分级沿用）
  const lostItems = score.boards
    .flatMap(b =>
      b.items
        .filter(it => it.status === "verified" && it.score != null)
        .map(it => ({
          boardId: b.id,
          boardName: b.name,
          id: it.id,
          name: it.name,
          lost: it.maxScore - (it.score ?? 0),
        }))
    )
    .sort((a, b) => b.lost - a.lost)
  const item = lostItems[index % Math.max(lostItems.length, 1)]
  const level: AuditImprovementPriority["level"] = index < 2 ? "P0" : index === 2 ? "P1" : "P2"
  if (!item || item.lost <= 0) {
    return {
      level,
      title: "补齐 Listing 核心内容资产",
      impact: "中",
      effort: "中",
      action: "按标题、Bullet、图片、A+、Q&A 顺序补齐缺失字段并重新打分。",
    }
  }
  return {
    level,
    title: `修复低分项目：${item.boardId} ${item.name}`,
    impact: "高",
    effort: index < 2 ? "低" : "中",
    action: `优先处理 ${item.boardId} ${item.name} 的扣分原因（来源规则 ID ${item.id}），并把对应建议同步到标题、Bullet、图片或 A+。`,
  }
}

/**
 * 交付物归一化（v2.0 §七：不设数量目标——由诊断倒推决定数量；服务端只做保底回退，不强制补齐到固定数量）。
 * 保留：title 空回退 ASIN、searchTerms 空回退 D/C 词、fieldRewrites/improvementPriorities 不丢。
 * v2.4：searchTerms 与 keywordTiers 关键词过禁词红线机械清洗（命中剔除并告警）。
 */
export function normalizeOptimizeResult(
  result: AuditOptimizeResult,
  evidence: AuditEvidence,
  score: AuditScoreResult
): AuditOptimizeResult {
  const baseTitle = firstListingTitle(evidence)
  const fallbackTerms = fallbackSearchTerms(evidence)

  const searchTerms = cleanKeywordList(result.listing.searchTerms)
  const keywordTiers = (result.keywordTiers ?? []).map(tier => ({
    ...tier,
    keywords: cleanKeywordList(tier.keywords),
  }))

  const listing: AuditOptimizeListing = {
    title: result.listing.title || baseTitle,
    bullets: result.listing.bullets,
    description: result.listing.description,
    searchTerms: searchTerms.length > 0 ? searchTerms : fallbackTerms,
    qaCandidates: result.listing.qaCandidates,
  }

  const fieldRewrites = result.fieldRewrites ?? []

  const improvementPriorities = result.improvementPriorities?.length
    ? result.improvementPriorities
    : [0, 1, 2, 3].map(i => scorePriorityFallback(score, i))

  return {
    listing,
    imageSellingPoints: result.imageSellingPoints,
    aplusModules: result.aplusModules,
    keywordTiers,
    reviewStrategies: result.reviewStrategies,
    differentiationUSPs: result.differentiationUSPs,
    launchPhases: result.launchPhases,
    fieldRewrites,
    improvementPriorities,
  }
}

/** 容错解析 LLM 输出为 AuditOptimizeResult；单字段缺失不整体失败（等价迁移 Web finalizeOptimizeResult）。 */
export function finalizeOptimizeResult(
  text: string,
  evidence: AuditEvidence,
  score: AuditScoreResult
): AuditOptimizeResult {
  const jsonStr = extractJson(text)
  if (!jsonStr) throw new Error("No JSON found in audit optimize response")
  const raw = parseLlmJson<Record<string, unknown>>(jsonStr)

  const result: AuditOptimizeResult = {
    listing: parseListing(raw.listing),
    imageSellingPoints: parseImageSellingPoints(raw.imageSellingPoints),
    aplusModules: parseAplusModules(raw.aplusModules),
    keywordTiers: parseKeywordTiers(raw.keywordTiers),
    reviewStrategies: parseReviewStrategies(raw.reviewStrategies),
    differentiationUSPs: parseDifferentiationUSPs(raw.differentiationUSPs),
    launchPhases: parseLaunchPhases(raw.launchPhases),
    fieldRewrites: parseFieldRewrites(raw.fieldRewrites),
    improvementPriorities: parseImprovementPriorities(raw.improvementPriorities),
  }

  if (!result.listing.title && result.listing.bullets.length === 0) {
    throw new Error("Invalid optimize response: listing 主体为空")
  }

  return normalizeOptimizeResult(result, evidence, score)
}

/**
 * ASIN 审计优化交付物（流式，等价迁移 Web streamAuditOptimize）：
 * 证据归一化 + 评分上下文 → 拼 prompt → streamChat（temperature 0.8）→ 累积 text →
 * 结算计费 → finalizeOptimizeResult → result 事件。
 * 计费失败向上抛，由控制器转 error 事件终止（不发 result）。
 */
@Injectable()
export class AuditOptimizeService {
  private readonly logger = new Logger(AuditOptimizeService.name)

  constructor(
    private readonly gateway: AiGatewayProvider,
    private readonly billing: AsinAuditBilling
  ) {}

  async *stream(dto: OptimizeRequestDto, userId: number): AsyncGenerator<AsinAuditSseEvent> {
    // 固定积分预检（仅固定价模型）
    await this.billing.assertFixedStageAffordable(userId, dto.model, "optimize")
    const evidence = normalizeAuditEvidence(
      dto.evidence as unknown as DeEvidenceResult,
      (dto.market ?? "amazon_us") as Market,
      dto.pastedContent,
      dto.abpc
    )
    const score = dto.score as unknown as AuditScoreResult
    const responseLanguage = dto.responseLanguage ?? "zh-CN"
    const userPrompt = buildAsinAuditOptimizeUserPrompt(evidence, score)
    const systemPrompt = `${buildAsinAuditOptimizeSkill()}\n\n${modelResponseLanguageDirective(responseLanguage, true)}`

    let textBuffer = ""
    for await (const event of this.gateway.streamChat(systemPrompt, userPrompt, {
      model: dto.model,
      temperature: 0.8,
      operationName: `ASIN 审计${asinAuditActionLabel("optimize")}`,
      resolveBilling: true,
    })) {
      if (event.type === "text") {
        textBuffer += event.content
        yield { type: "text", content: event.content }
        continue
      }
      if (event.type === "thinking") {
        yield { type: "thinking", content: event.content }
        continue
      }
      if (event.type === "usage" && event.usage) {
        yield { type: "usage", usage: event.usage }
        continue
      }
      if (event.type === "billing" && event.billing) {
        // 先解析后计费：解析失败不扣分（与 Web 前端「成功才上报 usage」口径一致）
        const result = finalizeOptimizeResult(textBuffer, evidence, score)
        // 固定价模型走一口价 15，非固定模型回落按量
        const billed =
          (await this.billing.chargeFixedStage(userId, dto.model, "optimize", {
            ...(dto.clientRequestId ? { clientRequestId: dto.clientRequestId } : {}),
          })) ||
          (await this.billing.charge(
            userId,
            dto.model,
            "optimize",
            event.billing,
            dto.clientRequestId
          ))
        this.logger.log(
          `[asin-audit] optimize finalized userId=${userId} asin=${evidence.asin} title=${result.listing.title.slice(0, 40)}`
        )
        yield {
          type: "result",
          data: result,
          billingHandled: billed,
          requestId: event.billing.requestId,
        }
      }
    }
  }
}
