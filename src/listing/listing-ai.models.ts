import { DOMESTIC_BUSINESS_MODELS } from "../common/business-ai/domestic-business-models"

export const LISTING_AI_MODELS = DOMESTIC_BUSINESS_MODELS
// 保留原内部角色守卫的权限约束；这些模型同时会被国产模型白名单拒绝。
export const INTERNAL_LISTING_AI_MODELS = ["claude-haiku-5-5", "gpt-6-luna", "gpt-6.1-sol"] as const
export type ListingAiModel = string
