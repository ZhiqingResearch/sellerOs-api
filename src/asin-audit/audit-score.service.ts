import { Injectable, Logger } from "@nestjs/common"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { isJsonObject } from "../common/utils/canonical-json"
import { AsinAuditBilling } from "./asin-audit.billing"
import type { AsinAuditSseEvent } from "./asin-audit.types"
import { asinAuditActionLabel } from "./asin-audit.types"
import type { ScoreRequestDto } from "./dto/score.dto"
import { buildAsinAuditScoreUserPrompt } from "./prompts/asin-audit-score"
import { modelResponseLanguageDirective } from "./prompts/model-response-language"
import { buildAsinAuditScoreSkill } from "./prompts/skill-assembler"
import { extractAdScore } from "./rules/ad-score"
import { resolveAuditCategory } from "./rules/audit-category"
import {
  AUDIT_BOARD_CONTRACT,
  CONTENT_BOARD_IDS,
  MIN_COVERAGE_FOR_TOTAL,
  OPERATIONS_BOARD_IDS,
} from "./rules/board-contract"
import { enforceTitlePolicyGate } from "./rules/cdq-policy"
import { extractJson, parseLlmJson } from "./rules/extract-json"
import { collectMissingEvidence, normalizeAuditEvidence } from "./rules/normalize-evidence"
import { auditGrade, auditGradeLabel, auditGradeNarrative } from "./rules/problem-types"
import { precheckBrandInTitle } from "./rules/title-precheck"
// TODO(关键词与流量建议): 暂时下线评分结果 trafficSuggestions，优化好后恢复接入（连同 finalizeScoreResult 中的输出行一起放开）
// import { buildTrafficSuggestionsFromPrecompute } from "./rules/traffic-suggestions"
import type {
  AuditBoard,
  AuditEvidence,
  AuditItemDeduction,
  AuditScoreLlmPayload,
  AuditScoreResult,
  DeEvidenceResult,
} from "./types/audit.types"
import type { Market } from "./types/scout.types"

/** v2.0 §3.3：A/V/E 三分母；只有全部适用项目都已核验（V=A）才是完整最终分 */
interface ScoreAggregates {
  applicableMax: number // A = 100 − Σna 满分
  evidenceMax: number // V = A − Σpending 满分
  earnedScore: number // E = Σverified 得分
  convertedScore: number | null // 100×E/V（V=0 → null）
  coverageRate: number // V/A
  isComplete: boolean
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * deduction 归属/事实护栏（v2.0 §3.3「同一问题只记唯一 owner」的服务端兜底）：
 * 模型把别家项目的扣分写进当前项目（如 E3 的视频缺失写进 E1），或推翻机械预检事实
 * （如标题明明含品牌词却说「未包含品牌词」）时，丢弃越界 deduction 并把扣分返还给本项目。
 * 仅覆盖细则上机械可判的条目；规则外的 deduction 原样保留（不做语义审判）。
 */
const E1_VIDEO_DEDUCTION_RE = /视频/
const A1_BRAND_MISSING_RE =
  /(品牌(词)?\s*(未|不|缺|没有|无))|((未|不|没有|无|缺(少|乏)?)[^。；;，,]{0,6}(包含|含有|出现|检出|找到|体现)[^。；;，,]{0,6}品牌)|(缺(少|乏)[^。；;，,]{0,4}品牌)|(missing\s+brand|no\s+brand|brand\s+(is\s+)?(not|missing|absent))/i

export interface DeductionGuards {
  /** A1 机械预检：品牌词是否在标题中；null/undefined = 未预检，不拦截 */
  a1BrandInTitle?: boolean | null
}

function guardItemDeductions(
  itemId: string,
  deductions: AuditItemDeduction[],
  guards: DeductionGuards | undefined
): { deductions: AuditItemDeduction[]; refund: number } {
  const list = Array.isArray(deductions) ? deductions : []
  const kept: AuditItemDeduction[] = []
  let refund = 0
  for (const d of list) {
    let violated = false
    if (itemId === "E2") {
      // E2 细则「默认满分，不做扣分，只出建议」——任何 deduction 均越界
      violated = true
    } else if (itemId === "E1" && E1_VIDEO_DEDUCTION_RE.test(d?.reason ?? "")) {
      // E1 无视频检查点：视频缺失唯一归属 E3，写进 E1 必为重复扣分
      violated = true
    } else if (
      itemId === "A1" &&
      guards?.a1BrandInTitle === true &&
      A1_BRAND_MISSING_RE.test(d?.reason ?? "")
    ) {
      // 机械预检确认品牌词在标题中，模型「未包含品牌词」为事实误判
      violated = true
    }
    if (violated) refund += Math.abs(d?.points ?? 0)
    else kept.push(d)
  }
  return { deductions: kept, refund }
}

/**
 * 校验并矫正模型 boards：
 * - 结构性错误（板块数/顺序/id/weight/maxScore/项目数不一致）→ 抛错不伪成功（输出形状崩了，重试也一样）
 * - 值级矛盾（模型常见噪音）→ 服务端矫正而非失败：
 *   · pending/na 项带了 score（如 E3 pending 却写 0）→ 信任 status，置 null
 *   · verified 项 score 缺失 → 降级为 pending（无证据不猜分）
 *   · verified 项 score 越界/NaN → 钳制到 [0, maxScore]
 *   · status 缺失 → 有分数视为 verified，无分数视为 pending
 * - deduction 护栏：越界 deduction 丢弃并返还扣分（见 guardItemDeductions）
 */
function validateAndSanitizeBoards(boards: AuditBoard[], guards?: DeductionGuards): AuditBoard[] {
  if (!Array.isArray(boards) || boards.length !== AUDIT_BOARD_CONTRACT.length) {
    throw new Error(
      `Invalid score response: expected ${AUDIT_BOARD_CONTRACT.length} boards, got ${boards?.length ?? 0}`
    )
  }
  return boards.map((board, i) => {
    const spec = AUDIT_BOARD_CONTRACT[i]
    if (!board || board.id !== spec.id) {
      throw new Error(
        `Invalid score response: board[${i}] expected id=${spec.id}, got ${board?.id ?? "(missing)"}`
      )
    }
    if (board.weight !== spec.weight || board.maxScore !== spec.maxScore) {
      throw new Error(
        `Invalid score response: board ${spec.id} weight/maxScore mismatch（期望 ${spec.weight}/${spec.maxScore}，得到 ${board.weight}/${board.maxScore}）`
      )
    }
    if (!Array.isArray(board.items) || board.items.length !== spec.items.length) {
      throw new Error(
        `Invalid score response: board ${spec.id} expected ${spec.items.length} items, got ${board.items?.length ?? 0}`
      )
    }
    const items = board.items.map((item, j) => {
      const itemSpec = spec.items[j]
      if (!item || item.id !== itemSpec.id) {
        throw new Error(
          `Invalid score response: board ${spec.id} item[${j}] expected id=${itemSpec.id}, got ${item?.id ?? "(missing)"}`
        )
      }
      if (item.maxScore !== itemSpec.maxScore) {
        throw new Error(
          `Invalid score response: item ${itemSpec.id} maxScore expected ${itemSpec.maxScore}, got ${item.maxScore}`
        )
      }
      const { deductions, refund } = guardItemDeductions(itemSpec.id, item.deductions, guards)
      const rawStatus = item.status
      let status: "verified" | "pending" | "na"
      if (rawStatus === "verified" || rawStatus === "pending" || rawStatus === "na") {
        status = rawStatus
      } else {
        status = item.score != null ? "verified" : "pending"
      }

      if (status !== "verified") {
        // 待核/不适用：信任 status，丢弃模型可能残留的分数（E3 pending 写 0 之类的噪音）
        return { ...item, score: null, status, deductions }
      }
      if (typeof item.score !== "number" || !Number.isFinite(item.score)) {
        // verified 却没有合法分数：降级为 pending（无证据不猜分）
        return {
          ...item,
          score: null,
          status: "pending" as const,
          pendingReason: item.pendingReason ?? "模型未给出分数",
          deductions,
        }
      }
      // 钳制越界；护栏返还：越界 deduction 的扣分还给本项目（总分随后由服务端重算）
      const clamped = Math.min(itemSpec.maxScore, Math.max(0, item.score))
      const restored = Math.min(itemSpec.maxScore, clamped + refund)
      return { ...item, score: restored, status, deductions }
    })
    return { ...board, items }
  })
}

/** 服务端重算 A/V/E、板块得分、域分（不信模型聚合值） */
function recomputeAggregates(boards: AuditBoard[]): {
  scoring: ScoreAggregates
  boardScores: Map<string, number | null>
  domainScores: { content: number | null; operations: number | null }
} {
  const boardScores = new Map<string, number | null>()
  let naMax = 0
  let pendingMax = 0
  let earned = 0

  for (const board of boards) {
    let boardEarned = 0
    let boardVerifiedMax = 0
    for (const item of board.items) {
      const status = item.status ?? (item.score != null ? "verified" : "pending")
      if (status === "na") {
        naMax += item.maxScore
        continue
      }
      if (status === "pending") {
        pendingMax += item.maxScore
        continue
      }
      boardEarned += item.score ?? 0
      boardVerifiedMax += item.maxScore
      earned += item.score ?? 0
    }
    boardScores.set(
      board.id,
      boardVerifiedMax > 0 ? round2((boardEarned / boardVerifiedMax) * 100) : null
    )
  }

  const applicableMax = 100 - naMax
  const evidenceMax = applicableMax - pendingMax
  const convertedScore = evidenceMax > 0 ? round2((100 * earned) / evidenceMax) : null
  const coverageRate = applicableMax > 0 ? round2(evidenceMax / applicableMax) : 0

  const domainScore = (ids: readonly string[]): number | null => {
    let earnedSum = 0
    let verifiedMaxSum = 0
    for (const id of ids) {
      const board = boards.find(b => b.id === id)
      if (!board) continue
      for (const item of board.items) {
        const status = item.status ?? (item.score != null ? "verified" : "pending")
        if (status !== "verified") continue
        earnedSum += item.score ?? 0
        verifiedMaxSum += item.maxScore
      }
    }
    return verifiedMaxSum > 0 ? round2((earnedSum / verifiedMaxSum) * 100) : null
  }

  return {
    scoring: {
      applicableMax,
      evidenceMax,
      earnedScore: earned,
      convertedScore,
      coverageRate,
      isComplete: evidenceMax === applicableMax,
    },
    boardScores,
    domainScores: {
      content: domainScore(CONTENT_BOARD_IDS),
      operations: domainScore(OPERATIONS_BOARD_IDS),
    },
  }
}

/**
 * 打分确定性后处理（v2.0 十板块）：
 * 契约校验 → A/V/E/板块/域分服务端重算 → 覆盖率 <60% 不出总分 → 标题违禁词合规门 → 流量建议兜底。
 */
export function finalizeScoreResult(
  payload: AuditScoreLlmPayload,
  evidence: AuditEvidence
): AuditScoreResult {
  // A1 品牌词机械预检（确定性问题）：true 时拦截「标题未包含品牌词」类误判 deduction
  const brandPrecheck = precheckBrandInTitle(evidence.A, evidence.P)
  const boards = validateAndSanitizeBoards(payload.boards ?? [], {
    a1BrandInTitle: brandPrecheck?.inTitle ?? null,
  })

  const { scoring, boardScores, domainScores } = recomputeAggregates(boards)

  // total：覆盖率 ≥60% 且 V>0 才出总分；否则 null（前端展示折算分 + 覆盖率）
  const total = scoring.coverageRate >= MIN_COVERAGE_FOR_TOTAL ? scoring.convertedScore : null
  const gradeBase = total ?? scoring.convertedScore ?? 0
  const grade = auditGrade(gradeBase)

  const result: AuditScoreResult = {
    historyTitle: payload.historyTitle?.trim() || `${evidence.asin} 审计`,
    total,
    grade,
    gradeLabel: auditGradeLabel(grade),
    domainScores,
    boards: boards.map(b => ({ ...b, score: boardScores.get(b.id) ?? null })),
    scoring: {
      applicableMax: scoring.applicableMax,
      evidenceMax: scoring.evidenceMax,
      earnedScore: round2(scoring.earnedScore),
      convertedScore: scoring.convertedScore,
      coverageRate: scoring.coverageRate,
      isComplete: scoring.isComplete,
    },
    diagnosis: payload.diagnosis ?? {
      weakestBoards: [],
      contentNarrative: "",
      operationsNarrative: "",
      issues: [],
    },
    aiVerdict: payload.aiVerdict ?? "",
    aiSecondary: payload.aiSecondary ?? "",
    actionItems: Array.isArray(payload.actionItems) ? payload.actionItems : [],
    suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : [],
    ...(payload.adDiagnostics != null ? { adDiagnostics: payload.adDiagnostics } : {}),
    trafficPrecompute: evidence.D.trafficPrecompute,
    // TODO(关键词与流量建议): 暂时下线该板块，优化好后恢复接入——恢复时连同下方 import 一起放开
    // trafficSuggestions: buildTrafficSuggestionsFromPrecompute(evidence.D.trafficPrecompute),
    missingEvidence: collectMissingEvidence(evidence),
    severeDefects: payload.severeDefects,
  }

  // 标题违禁词合规门（保留的合规兜底，不属于已取消机械门槛）：命中 → total=0 + POOR
  if (evidence.A.filled && evidence.A.title) {
    const gated = enforceTitlePolicyGate(
      {
        total: result.total ?? 0,
        dimensions: [],
        suggestions: result.suggestions,
        potential: auditGradeNarrative(grade),
        severeDefects: result.severeDefects,
      },
      evidence.A.title
    )
    if (gated.total === 0) {
      result.total = 0
      result.grade = "POOR"
      result.gradeLabel = auditGradeLabel("POOR")
      result.suggestions = gated.suggestions
      result.severeDefects = gated.severeDefects
    }
  }

  // 归档兼容摘要（AsinAuditRecord 摘要列口径）：v1 归档契约要求数字分，此处服务端确定性附带，
  // 前端把 scoreResult 原样回传 /asin-audit/records 即可落库；total=null（覆盖率不足不出总分）
  // 时用折算分兜底，域分无已核验项为 0，广告分从 adDiagnostics 提取（未上传/提不出缺省）。
  const adScore = extractAdScore(payload.adDiagnostics)
  result.overallScore = round2(result.total ?? scoring.convertedScore ?? 0)
  result.contentScore = domainScores.content ?? 0
  result.trafficScore = domainScores.operations ?? 0
  if (adScore != null) {
    result.adScore = adScore
    // 前端归档预检只认 adDiagnostics 顶层 score → total → overallScore 三个字段名——
    // 模型只给 dimensions、或数值越界时，把提取/钳制结果回写为规范化顶层 score，
    // 保证前端首选字段恒有效（完全提不出时不回写，前端按「未返回有效广告分」中止，与本侧口径一致）
    if (isJsonObject(payload.adDiagnostics)) {
      result.adDiagnostics = { ...payload.adDiagnostics, score: adScore }
    }
  }

  return result
}

/**
 * ASIN 审计打分（流式，v2.0 十板块）：
 * 证据归一化 → 拼 prompt → streamChat（temperature 0）→ 累积 text →
 * 结算计费 → extractJson/parseLlmJson → finalizeScoreResult → result 事件。
 * 计费失败（余额不足/账单未就绪）向上抛，由控制器转 error 事件终止（不发 result）。
 */
@Injectable()
export class AuditScoreService {
  private readonly logger = new Logger(AuditScoreService.name)

  constructor(
    private readonly gateway: AiGatewayProvider,
    private readonly billing: AsinAuditBilling
  ) {}

  async *stream(dto: ScoreRequestDto, userId: number): AsyncGenerator<AsinAuditSseEvent> {
    // 固定积分预检（仅固定价模型；打分 20 已含审计链取证成本）
    await this.billing.assertFixedStageAffordable(userId, dto.model, "score")
    const evidence = normalizeAuditEvidence(
      dto.evidence as unknown as DeEvidenceResult,
      (dto.market ?? "amazon_us") as Market,
      dto.pastedContent,
      dto.abpc
    )
    const responseLanguage = dto.responseLanguage ?? "zh-CN"
    const userPrompt = buildAsinAuditScoreUserPrompt(evidence)
    // 类目覆盖层（v2.3）：按类目路径确定性判定，命中电脑类目追加冻结清单 prompt
    const category = resolveAuditCategory(evidence, dto.categoryHint)
    const systemPrompt = `${buildAsinAuditScoreSkill(category)}\n\n${modelResponseLanguageDirective(responseLanguage)}`

    let textBuffer = ""
    for await (const event of this.gateway.streamChat(systemPrompt, userPrompt, {
      model: dto.model,
      temperature: 0,
      operationName: `ASIN 审计${asinAuditActionLabel("score")}`,
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
        const jsonStr = extractJson(textBuffer)
        if (!jsonStr) throw new Error("No JSON found in audit score response")
        const payload = parseLlmJson<AuditScoreLlmPayload>(jsonStr)
        const result = finalizeScoreResult(payload, evidence)
        // 固定价模型走一口价 20（打分含审计链取证成本），非固定模型回落按量
        const billed =
          (await this.billing.chargeFixedStage(userId, dto.model, "score", {
            ...(dto.clientRequestId ? { clientRequestId: dto.clientRequestId } : {}),
          })) ||
          (await this.billing.charge(
            userId,
            dto.model,
            "score",
            event.billing,
            dto.clientRequestId
          ))
        this.logger.log(
          `[asin-audit] score finalized userId=${userId} asin=${evidence.asin} category=${category ?? "generic"} total=${result.total} coverage=${result.scoring.coverageRate}`
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
