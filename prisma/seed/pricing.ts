import { PricingCategory, PricingTier, PrismaClient } from "@prisma/client"

const PRICING_CONFIGS = [
  {
    key: "TOKEN_INPUT_LOW",
    name: "输入 Token（≤20万）",
    category: PricingCategory.TOKEN_INPUT,
    tier: PricingTier.LOW,
    threshold: 200000,
    originalPriceUsd: "1",
    markupPriceUsd: "1.5",
    markupPriceCny: "10.25",
    unit: "MTok",
    description: "提示词 token 数 ≤ 20 万时的输入单价",
  },
  {
    key: "TOKEN_INPUT_HIGH",
    name: "输入 Token（>20万）",
    category: PricingCategory.TOKEN_INPUT,
    tier: PricingTier.HIGH,
    threshold: 200000,
    originalPriceUsd: "2",
    markupPriceUsd: "3",
    markupPriceCny: "20.5",
    unit: "MTok",
    description: "提示词 token 数 > 20 万时的输入单价",
  },
  {
    key: "TOKEN_OUTPUT_LOW",
    name: "输出 Token（≤20万档）",
    category: PricingCategory.TOKEN_OUTPUT,
    tier: PricingTier.LOW,
    threshold: 200000,
    originalPriceUsd: "6",
    markupPriceUsd: "9",
    markupPriceCny: "61.51",
    unit: "MTok",
    description: "输入 token 数 ≤ 20 万时，输出+思考 token 的单价",
  },
  {
    key: "TOKEN_OUTPUT_HIGH",
    name: "输出 Token（>20万档）",
    category: PricingCategory.TOKEN_OUTPUT,
    tier: PricingTier.HIGH,
    threshold: 200000,
    originalPriceUsd: "9",
    markupPriceUsd: "13.5",
    markupPriceCny: "92.27",
    unit: "MTok",
    description: "输入 token 数 > 20 万时，输出+思考 token 的单价",
  },
  {
    key: "MCP_CALL",
    name: "MCP 调用",
    category: PricingCategory.MCP,
    tier: PricingTier.SINGLE,
    threshold: null,
    originalPriceUsd: "0",
    markupPriceUsd: "0",
    markupPriceCny: "0.12375",
    unit: "call",
    description: "MCP 每次调用人民币单价（溢价后 123.75 元 / 1000 次）",
  },
]

export async function seedPricing(prisma: PrismaClient) {
  for (const p of PRICING_CONFIGS) {
    await prisma.pricingConfig.upsert({
      where: { key: p.key },
      update: {
        name: p.name,
        category: p.category,
        tier: p.tier,
        threshold: p.threshold,
        originalPriceUsd: p.originalPriceUsd,
        markupPriceUsd: p.markupPriceUsd,
        markupPriceCny: p.markupPriceCny,
        unit: p.unit,
        description: p.description,
      },
      create: p,
    })
  }
  return { count: PRICING_CONFIGS.length }
}
