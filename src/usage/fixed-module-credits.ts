import { BadRequestException } from "@nestjs/common"

/** 完整业务结果成功交付的固定售价，中间 AI / 数据步骤不额外计费。 */
export const FIXED_MODULE_CREDITS = {
  "listing.generate": 25,
  "listing.score": 15,
  "category.analysis": 80,
  "flow.workbench": 50,
  "competitor.research": 25,
  "launch.plan": 15,
  "pricing.quote": 10,
} as const

export type FixedModuleSource = keyof typeof FIXED_MODULE_CREDITS

export function listingGenerationChargeId(userId: number, billingId: string): string {
  return `listing-generation:${userId}:${billingId}`
}

export function getFixedModuleCredits(source: FixedModuleSource, operation?: string, quantity = 1): number {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || (source === "competitor.research" && quantity > 3) || (source === "category.analysis" && quantity > 5))
    throw new BadRequestException("计费数量无效")
  return operation === "optimization" && (source === "listing.generate" || source === "listing.score")
    ? 5
    : FIXED_MODULE_CREDITS[source] * (source === "competitor.research" || source === "category.analysis" ? quantity : 1)
}
