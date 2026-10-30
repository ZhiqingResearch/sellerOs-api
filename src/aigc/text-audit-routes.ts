/** 只用于模型调用前被全局审核拒绝的日志；正常调用在共享文本Provider记录。 */
export function isTextGenerationRequest(method: string, path: string, body: unknown): boolean {
  if (method !== "POST") return false
  const route = path.replace(/^\/api(?=\/)/, "")
  if (
    /^\/(?:internal\/)?llm-toolbox\/(?:enhance-prompt|translate-prompt|image-inference)$/.test(
      route
    )
  )
    return true
  if (/\/ai\/(?:complete|stream)$/.test(route)) return true
  if (/^\/listing\/(?:generations|documents\/analyze)$/.test(route)) return true
  if (/^\/competitor-analysis\/(?:analyze|profile|traffic|price-promo|summary)$/.test(route))
    return true
  if (/^\/asin-audit\/(?:review-pain-points|score|optimize)$/.test(route)) return true
  if (/^\/(?:category-analysis(?:\/\d+\/categories)?|video-analysis)$/.test(route)) return true
  if (/^\/customer\/(?:account\/)?\d+\/regenerate-strategy$/.test(route)) return true
  if (/^\/customer\/production\/generate-(?:script|copywriting)$/.test(route)) return true
  if (
    /^\/customer\/project\/\d+\/(?:deep-search|search-hotspots|strategy\/generate|storyboards\/generate|materials\/generate)$/.test(
      route
    )
  )
    return true
  if (/^\/chetaidou\/(?:images\/\d+\/breakdown\/retry|compositions\/[^/]+\/answers)$/.test(route))
    return true
  if (route === "/chetaidou/tasks") {
    const type = (body as { type?: string } | null)?.type
    return ["IDEATION", "REFRESH_GROUP", "DIVERGE", "COMPOSE"].includes(type ?? "")
  }
  return false
}
