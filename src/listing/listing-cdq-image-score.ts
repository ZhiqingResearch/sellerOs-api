interface ImageDeduction {
  points: number
  reason: string
  ruleId?: string
  evidence?: string
}

/** 仅使用图片项明确写出的数量/覆盖证据，修正矛盾扣分并校验四个检查点上限。 */
export function normalizeCdqImageCriterion(criterion: Record<string, unknown>): void {
  const description = String(criterion.description)
  const deductions = criterion.deductions as ImageDeduction[]
  const countMatch = description.match(/副图(?:数量|张数)?\s*[：:]?\s*(\d+)\s*张/)
  const hasEnoughImages = countMatch !== null && Number(countMatch[1]) >= 6
  // 只接受肯定列出四类的同一句证据；“未覆盖/缺失/无法确认”等不能作为满覆盖依据。
  const coverageClauses = description.split(/[；;。.!?\n]/).filter(clause => /覆盖/.test(clause))
  const hasMissingCoverage = coverageClauses.some(clause => /未|无|缺|不|待|可能|或|尚|待确认/.test(clause))
  const hasFullCoverage = !hasMissingCoverage && coverageClauses.some(clause =>
    /覆盖(?:了)?\s*[：:]?\s*(?:使用)?场景[、,，/\s]+(?:细节(?:特写)?)[、,，/\s]+(?:尺寸(?:对比)?)[、,，/\s]+包装(?:清单|等)?/.test(clause)
  )
  const revisedDeductions = deductions.filter(deduction => {
    const reason = deduction.reason
    // 肯定的白底描述不构成违规；低分辨率只能归入可放大检查点。
    const complianceReason = reason.replace(/虽为白底|无水印|无文字|无边框|占比合规/g, "")
    if (deduction.ruleId === "image.compliance" &&
      /像素|分辨率|长边|放大|充电盒/.test(reason) &&
      !/白底|背景|水印|文字|边框|占比|85%|RGB/i.test(complianceReason)) return false
    if (!/^副图/.test(reason)) return true
    // 明确指出了其他图片缺陷或缺少哪类内容时，不能仅凭汇总描述抹掉扣分。
    if (/模糊|水印|文字|错误|矛盾|不一致|遮挡|侵权|重复|(?:缺|未|无|不).*(?:场景|细节|尺寸|包装)/.test(reason)) return true
    const isCountDeduction = /数量|张数|\d+\s*张/.test(reason)
    const isCoverageDeduction = /覆盖/.test(reason)
    if (isCountDeduction && isCoverageDeduction) return !(hasEnoughImages && hasFullCoverage)
    if (isCountDeduction) return !hasEnoughImages
    if (isCoverageDeduction) return !hasFullCoverage
    return true
  })

  let mainCompliance = 0
  let mainZoom = 0
  let galleryCount = 0
  let galleryCoverage = 0
  let galleryCombined = 0
  for (const deduction of revisedDeductions) {
    const reason = deduction.reason
    if (deduction.ruleId === "image.compliance") mainCompliance += deduction.points
    else if (deduction.ruleId === "image.zoom") mainZoom += deduction.points
    else if (deduction.ruleId === "image.count") galleryCount += deduction.points
    else if (deduction.ruleId === "image.coverage") galleryCoverage += deduction.points
    else if (/^主图/.test(reason)) {
      if (/长边|分辨率|像素|放大|\d+\s*px/i.test(reason)) mainZoom += deduction.points
      else mainCompliance += deduction.points
    } else if (/^副图/.test(reason)) {
      const isCount = /数量|张数|\d+\s*张/.test(reason)
      const isCoverage = /覆盖|场景|细节|尺寸|包装/.test(reason)
      if (isCount && isCoverage) galleryCombined += deduction.points
      else if (isCount) galleryCount += deduction.points
      else if (isCoverage) galleryCoverage += deduction.points
    }
  }
  if (mainCompliance > 6 || mainZoom > 3 || galleryCount > 3 || galleryCoverage > 3 ||
    galleryCount + galleryCoverage + galleryCombined > 6) {
    throw new Error("图片扣分超过对应检查点满分，请重新核对")
  }
  if (revisedDeductions.length !== deductions.length) {
    criterion.deductions = revisedDeductions
    criterion.score = Math.round((15 - revisedDeductions.reduce((sum, item) => sum + item.points, 0)) * 10000) / 10000
    if (deductions.some(item => item.ruleId === "image.compliance") &&
      !revisedDeductions.some(item => item.ruleId === "image.compliance")) {
      criterion.description = description.replace(
        /(主图合规[（(]纯白底[、，,]无水印[、，,]占比合规[）)][，,]\s*)扣\s*\d+(?:\.\d+)?\s*分/g,
        "$1不扣分"
      )
    }
  }
}
