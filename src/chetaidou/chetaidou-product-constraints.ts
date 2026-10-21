/** 仅兼容旧冻结组合模板的编号入参；不用于逐字门槛或生图强制追加。 */
export interface ProductHardConstraint {
  constraintId: string
  sourceText: string
}

export function productHardConstraints(content: unknown): ProductHardConstraint[] {
  if (!content || typeof content !== "object" || Array.isArray(content)) return []
  const rules = (content as { hardConstraints?: unknown }).hardConstraints
  if (!Array.isArray(rules)) return []
  return rules.flatMap((rule: unknown, index) =>
    typeof rule === "string" && rule.trim()
      ? [{ constraintId: `fact_hard_${index + 1}`, sourceText: rule.trim() }]
      : []
  )
}
