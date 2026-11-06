/** 字符串原样保存；结构化输入只做 JSON 序列化，不生成摘要或拼接提示词。 */
export function inputString(value: unknown): string {
  if (typeof value === "string") return value
  return value == null ? "" : JSON.stringify(value)
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function listingUserInput(value: unknown): string {
  const data = object(value)
  const params = object(data.params)
  return inputString(params.keyword ?? data.params)
}

/** 读取现有接口字段，不要求前端增加字段。userInput 仅是后端内部留档键。 */
export function generationUserInput(source: string, value: unknown): string {
  const row = object(value)
  switch (source) {
    case "history":
      return listingUserInput(row.data)
    case "businessAiRun":
      return inputString(object(row.billing).userInput)
    case "asinEvidenceRecord":
    case "asinAuditRecord":
      return inputString(row.asin)
    case "categoryAnalysisRecord":
      return inputString(row.keywords ?? row.categories)
    case "selectionAnalysisRecord": {
      const steps = Array.isArray(row.steps) ? row.steps : []
      const payload = object(object(steps[0]).payload)
      return inputString(payload.sourceText ?? object(payload.productData).asin)
    }
    case "smartPricingRecord": {
      const product = object(row.product)
      return inputString(product.sourceText ?? product.sourceUrl ?? product.filenames)
    }
    case "competitorAnalysisRecord": {
      const input = object(row.inputSnapshot)
      return inputString(
        input.sourceText ?? input.keyword ?? (Object.keys(input).length ? input : undefined)
      )
    }
    case "promotionPlanRecord":
      return inputString(row.input)
    case "videoAnalysisRecord":
      return row.videoUrl == null && row.focus == null
        ? ""
        : inputString({ videoUrl: row.videoUrl, focus: row.focus })
    case "chetaidouTask":
      return inputString(row.input)
    case "generationTask": {
      const spec = object(row.executionSpec)
      if (typeof spec.userInput === "string") return spec.userInput
      if (row.generationMode === "AI_SPLIT")
        return inputString(object(object(row.promptConfig).reference).url)
      if (spec.mode === "product-image") return inputString(spec.form)
      return inputString(row.prompt)
    }
    case "imageGenJob": {
      const request = object(row.request)
      return inputString(request.userInput ?? request.prompt)
    }
    case "videoTask":
      return inputString(object(row.deliveryMeta).userInput ?? row.prompt)
    case "storyboardVideo":
      return inputString(object(row.generationParams).prompt)
    case "beautyTask":
      return inputString(row.beautyInput)
    case "inspirationSubscription":
      return inputString(row.keywords)
    case "rpaCreationTask":
      return inputString(row.prompt)
    default:
      return ""
  }
}
