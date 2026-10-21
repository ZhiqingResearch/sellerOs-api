import { PrismaClient } from "@prisma/client"

// LV1/2/3 会员套餐（套餐积分 + 赠送积分均进 PACKAGE 桶、30 天过期）
// 数值来自功能描述 / SellerOs HTML RC_TIERS。
// 人民币定价（2026-08-21 币种变更定稿：目录人民币计价、付款按汇率折美元）：
// ⚠️ originalPriceCny 划线价为占位（269/539/899），正式价格点由产品通知后替换（需求第 12 章问题 8）。
const MEMBERSHIP_PLANS = [
  {
    tier: 1,
    name: "Explorer",
    priceCny: "199",
    originalPriceCny: "221",
    packageCredits: 2000,
    giftCredits: 200,
  },
  {
    tier: 2,
    name: "Plus",
    priceCny: "399",
    originalPriceCny: "469",
    packageCredits: 4000,
    giftCredits: 600,
  },
  {
    tier: 3,
    name: "Ultra",
    priceCny: "699",
    originalPriceCny: "874",
    packageCredits: 7000,
    giftCredits: 2000,
  },
]

// 固定充值包（base 进 RECHARGE 永不过期；bonus 进 PACKAGE 30 天过期）
// 数值来自功能描述 / SellerOs HTML RC_PACKS；人民币定价（元）。
const RECHARGE_PACKS = [
  { priceCny: "30", baseCredits: 300, bonusCredits: 0, sortOrder: 1 },
  { priceCny: "100", baseCredits: 1000, bonusCredits: 100, sortOrder: 2 },
  { priceCny: "500", baseCredits: 5000, bonusCredits: 1000, sortOrder: 3 },
]

export async function seedMembership(prisma: PrismaClient) {
  for (const p of MEMBERSHIP_PLANS) {
    await prisma.membershipPlan.upsert({
      where: { tier: p.tier },
      update: {
        name: p.name,
        priceCny: p.priceCny,
        originalPriceCny: p.originalPriceCny,
        packageCredits: p.packageCredits,
        giftCredits: p.giftCredits,
      },
      create: p,
    })
  }

  // RechargePack 无自然唯一键，按 priceCny 对账（同价位视为同一充值包）。
  for (const p of RECHARGE_PACKS) {
    const existing = await prisma.rechargePack.findFirst({ where: { priceCny: p.priceCny } })
    if (existing) {
      await prisma.rechargePack.update({
        where: { id: existing.id },
        data: {
          baseCredits: p.baseCredits,
          bonusCredits: p.bonusCredits,
          sortOrder: p.sortOrder,
        },
      })
    } else {
      await prisma.rechargePack.create({ data: p })
    }
  }

  return { plans: MEMBERSHIP_PLANS.length, packs: RECHARGE_PACKS.length }
}
