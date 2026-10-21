/** 明确的规格片段；未匹配到不代表不合格，具名认证等仍由模型逐条判断。 */
export function findListingBulletDataPoint(text: string): { kind: string; quote: string } | undefined {
  const serviceTime = /\b24\s*[/／]\s*7\b/.exec(text)
  if (serviceTime && /support|service|assistan|help|服务|客服/i.test(text))
    return { kind: "numeric", quote: serviceTime[0] }
  const material = /\b\d+\s*[/／]\s*\d+\s+(?:stainless\s+)?steel\b/i.exec(text)
  if (material) return { kind: "specification", quote: material[0] }
  const quantity = /(?<![\p{L}\p{N}])\d+(?:[,.]\d+)*(?:\s*\+)?\s*(?:fl\s*oz|ml|mAh|kWh|Wh|GHz|MHz|GB|TB|dpi|mm|cm|inches|inch|kg|hours?|pages?|cycles?|bottles?|毫升|小时|页)(?![\p{L}\p{N}])/iu.exec(text)
  if (quantity) return { kind: "numeric", quote: quantity[0] }
  // 仅识别明确兼容/型号/防护语境，排除孤立版本号、日期、优惠比例和满意承诺。
  const model = /\b(?:IPX?\d{1,2}|[A-Z]{2,8}[-‐‑–]\d{2,}[A-Z0-9]*)\b/.exec(text)
  if (model && /compatib|models?|waterproof|resistan|rated|rating|防水|兼容|型号|等级/i.test(text))
    return { kind: "specification", quote: model[0] }
  return undefined
}
