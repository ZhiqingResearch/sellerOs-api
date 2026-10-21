export type ModelResponseLanguage = "zh-CN" | "en-US"

export function appLocaleForRegisterType(registerType: unknown): ModelResponseLanguage {
  return typeof registerType === "string" && registerType.trim().toUpperCase() === "EMAIL"
    ? "en-US"
    : "zh-CN"
}

/**
 * 仅约束模型返回中的说明性文本；商品 Listing 正文仍必须服从目标站点语言。
 */
export function modelResponseLanguageDirective(
  language: ModelResponseLanguage,
  preserveMarketplaceContent = false
): string {
  if (language === "en-US") {
    return preserveMarketplaceContent
      ? "HIGH-PRIORITY LANGUAGE RULE: Write all analysis, reasons, recommendations, labels, and explanatory fields in English. This overrides any Chinese-output instructions or Chinese examples in the task, schema, reference material, and previous results. Product listing copy (title, bullets, description, search terms, and other customer-facing marketplace content) must still use the selected marketplace's required language. Keep JSON keys and required enum values unchanged. Before responding, check that explanatory fields contain no untranslated Chinese."
      : "HIGH-PRIORITY LANGUAGE RULE: Write every user-facing value, explanation, reason, and recommendation in English. This overrides any Chinese-output instructions or Chinese examples in the task, schema, reference material, and previous results. Input language does not determine response language. Keep JSON keys and required enum values unchanged. Before responding, check that user-facing fields contain no untranslated Chinese."
  }

  return preserveMarketplaceContent
    ? "【高优先级语言要求】分析、理由、建议、标签及其他说明性字段使用简体中文；商品 Listing 正文（标题、Bullet、描述、Search Terms 等）仍严格使用目标站点要求的语言。JSON 键名和枚举值保持不变。"
    : "【高优先级语言要求】所有面向用户的文本、解释、理由和建议使用简体中文；JSON 键名和规定的枚举值保持不变。"
}
