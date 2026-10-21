import type { AuditEvidence, AuditScoreResult } from "../types/audit.types"
import { buildTrafficSuggestionsFromPrecompute } from "../rules/traffic-suggestions"
import { buildAuditEvidenceCards, cardSection } from "./asin-audit-prompt-format"

/** 把十板块打分结果格式化为优化上下文（v2.0：板块得分 + 低分项目 + 诊断 + 待核清单）。 */
function formatScoreContext(score: AuditScoreResult): string {
  const boardLines = score.boards
    .map(b => {
      const head = `- ${b.id} ${b.name}：${b.score != null ? `${b.score}/100（权重 ${b.weight}）` : "⏸ 全部待核/不适用"}`
      const lowItems = b.items
        .filter(
          it =>
            it.status === "verified" &&
            it.score != null &&
            it.maxScore > 0 &&
            it.score / it.maxScore < 1
        )
        .map(
          it =>
            `    · ${it.id} ${it.name}：${it.score}/${it.maxScore}${it.deductions?.length ? `（${it.deductions.map(d => `${d.reason} 扣 ${d.points}`).join("；")}）` : ""}`
        )
      const pendingItems = b.items
        .filter(it => it.status !== "verified")
        .map(
          it =>
            `    · ${it.id} ${it.name}：${it.status === "pending" ? `⏸ 待核（${it.pendingReason ?? "证据不足"}）` : `N/A（${it.naReason ?? "不适用"}）`}`
        )
      return [head, ...lowItems, ...pendingItems].filter(Boolean).join("\n")
    })
    .join("\n")

  const s = score.scoring
  const summaryLines = [
    `总分口径：${score.total != null ? `total ${score.total}` : "不出总分（覆盖率不足）"} · 折算分 ${s.convertedScore ?? "—"} · 证据覆盖率 ${Math.round(s.coverageRate * 100)}%（A=${s.applicableMax} / V=${s.evidenceMax} / E=${s.earnedScore}）`,
    `内容域 ${score.domainScores.content ?? "—"} · 运营域 ${score.domainScores.operations ?? "—"} · 等级 ${score.gradeLabel}`,
  ].join("\n")

  const diagnosis = score.diagnosis
  const diagnosisLines = [
    diagnosis?.contentNarrative ? `内容域话术：${diagnosis.contentNarrative}` : "",
    diagnosis?.operationsNarrative ? `运营域话术：${diagnosis.operationsNarrative}` : "",
    ...(diagnosis?.issues ?? []).map(
      iss =>
        `${iss.boardId} 板块问题：${iss.summary}\n${iss.evidences.map(e => `    · ${e}`).join("\n")}`
    ),
  ].filter(Boolean)

  const actionLines = score.actionItems?.length
    ? score.actionItems.map((a, i) => `${i + 1}. ${a}`).join("\n")
    : "（无）"

  // 评分结果已暂时下线 trafficSuggestions 字段（前端不展示该板块）；优化选词原料改为现场构建，注入内容不变。
  const trafficLines = (buildTrafficSuggestionsFromPrecompute(score.trafficPrecompute) ?? []).map(block => {
    const head = `#### ${block.ruleId} ${block.subDimension}：${block.summary}（扣 ${block.deducted}/${block.maxScore}，${block.level}）`
    const positionRows = (block.positionTable ?? []).map(
      row =>
        `    · ${row.kw}｜月搜索量 ${row.searchVolLabel}｜当日观测 ${row.currentRank}｜建议位置 ${row.suggestPosition}`
    )
    const opportunityRows = (block.opportunityTable ?? []).map(
      row =>
        `    · 机会词 ${row.kw}｜月搜索量 ${row.searchVolLabel}｜购买率 ${row.purchaseRatePct ?? "—"}%｜竞品自然占比 ${row.naturalRatioPct ?? "—"}%｜当日页码 ${row.page ?? "—"}`
    )
    return [head, ...positionRows, ...opportunityRows].join("\n")
  })

  const pendingNote =
    "待核项目（⏸/N/A）不得当成已扣分问题处理；优化动作只针对已核验扣分项，并标注来源规则 ID 与扣分。"

  return [
    summaryLines,
    boardLines,
    ...(diagnosisLines.length ? ["诊断：", ...diagnosisLines] : []),
    ...(trafficLines.length
      ? [
          "trafficSuggestions 四子维度（词位置 / 机会词原料，选词先过禁词红线与埋词去重、广告动作先看广告位）：",
          ...trafficLines,
        ]
      : []),
    `首要行动：\n${actionLines}`,
    pendingNote,
  ].join("\n\n")
}

/** 构造 ASIN 审计第三步 · 优化交付物 user prompt（v2.0 §七：由诊断倒推，不设数量目标）。 */
export function buildAsinAuditOptimizeUserPrompt(
  evidence: AuditEvidence,
  score: AuditScoreResult
): string {
  const { asin, country, market } = evidence

  let prompt = `# ASIN 审计第三步 · 优化交付物生成任务
ASIN：${asin}
站点（SIF）：${country}
市场：${market}

`

  prompt += buildAuditEvidenceCards(evidence)
  prompt += cardSection("第二步 · 十板块打分结果（优化输入，含待核项）", formatScoreContext(score))

  prompt += `\n请基于以上六卡证据与十板块打分结果，严格按 system prompt 输出 AuditOptimizeResult JSON。优化动作必须由诊断结论倒推（标注来源规则 ID 与扣分、给预期收益区间），不设图片/模块数量目标，仅输出 JSON。选词与改写遵守禁词红线（促销词 / 他人型号裸写 / 竞品品牌词一律不进 listing，兼容前缀表述除外）、埋词去重（标题已覆盖语义的词改埋 Bullet/QA/评论/描述）与广告建议闸门（先看 D 卡 ranking 广告位，无排名才建议开投/调价）。`

  return prompt
}
