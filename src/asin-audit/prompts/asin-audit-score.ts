import type { AuditEvidence } from "../types/audit.types"
import { buildAuditEvidenceCards } from "./asin-audit-prompt-format"

/** 构造 ASIN 审计打分 user prompt（服务端专用，可 import 自 server score-service）。 */
export function buildAsinAuditScoreUserPrompt(evidence: AuditEvidence): string {
  const { asin, country, market } = evidence

  let prompt = `# ASIN 审计打分任务
ASIN：${asin}
站点（SIF）：${country}
市场：${market}

`

  prompt += buildAuditEvidenceCards(evidence)

  prompt += `\n请严格按 system prompt 输出 JSON。boards 必须恰好 10 个（id 顺序 A→J 固定）、24 个计分项目齐全；待核项 score=null；不要输出任何聚合分数（服务端重算）。`

  return prompt
}
