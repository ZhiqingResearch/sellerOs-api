import { PrismaClient } from "@prisma/client"

// 团队套餐档（共享池积分均进 teamId 批次：套餐池 PACKAGE 30 天、赠送池 PACKAGE 30 天；周期 30 天）
// 人民币定价（元）（2026-08-21 币种变更定稿：目录人民币计价、付款按汇率折美元）。
// ⚠️ originalPriceCny 划线价为占位（1665/4284），正式价格点由产品通知后替换（需求第 12 章问题 8）。
const TEAM_PLANS = [
  {
    tier: 1,
    name: "团队版",
    priceCny: "1299",
    originalPriceCny: "1665",
    seats: 5,
    poolPackageCredits: 16000,
    poolGiftCredits: 3000,
  },
  {
    tier: 2,
    name: "旗舰版",
    priceCny: "2999",
    originalPriceCny: "4284",
    seats: 15,
    poolPackageCredits: 45000,
    poolGiftCredits: 10000,
  },
]

// 团队共享池充值包（base 进团队 RECHARGE 池永不过期；bonus 进团队 PACKAGE 池 30 天过期）
const TEAM_PACKS = [
  { priceCny: "500", baseCredits: 5000, bonusCredits: 500, sortOrder: 1 },
  { priceCny: "1000", baseCredits: 10000, bonusCredits: 1500, sortOrder: 2 },
  { priceCny: "5000", baseCredits: 50000, bonusCredits: 10000, sortOrder: 3 },
]

// 自定义充值阶梯（个人/团队两套独立阶梯；金额（元）>= 门槛命中最高一档）。
// 门槛为人民币口径（个人 ¥100/500/1000/5000；团队 ¥500/1000/5000）。
const CUSTOM_LADDER_TIERS = [
  { scope: "PERSONAL", minCny: "100", bonusRate: "0.10", sortOrder: 1 },
  { scope: "PERSONAL", minCny: "500", bonusRate: "0.20", sortOrder: 2 },
  { scope: "PERSONAL", minCny: "1000", bonusRate: "0.25", sortOrder: 3 },
  { scope: "PERSONAL", minCny: "5000", bonusRate: "0.30", sortOrder: 4 },
  { scope: "TEAM", minCny: "500", bonusRate: "0.10", sortOrder: 1 },
  { scope: "TEAM", minCny: "1000", bonusRate: "0.15", sortOrder: 2 },
  { scope: "TEAM", minCny: "5000", bonusRate: "0.20", sortOrder: 3 },
]

export async function seedBilling(prisma: PrismaClient) {
  for (const t of TEAM_PLANS) {
    await prisma.teamPlan.upsert({
      where: { tier: t.tier },
      update: {
        name: t.name,
        priceCny: t.priceCny,
        originalPriceCny: t.originalPriceCny,
        seats: t.seats,
        poolPackageCredits: t.poolPackageCredits,
        poolGiftCredits: t.poolGiftCredits,
      },
      create: t,
    })
  }

  // TeamPack 按 priceCny 对账（同价位视为同一包）
  for (const p of TEAM_PACKS) {
    const existing = await prisma.teamPack.findFirst({
      where: { priceCny: p.priceCny },
    })
    if (existing) {
      await prisma.teamPack.update({
        where: { id: existing.id },
        data: { baseCredits: p.baseCredits, bonusCredits: p.bonusCredits, sortOrder: p.sortOrder },
      })
    } else {
      await prisma.teamPack.create({ data: p })
    }
  }

  // 阶梯按 (scope, minCny) 对账
  for (const t of CUSTOM_LADDER_TIERS) {
    const existing = await prisma.customLadderTier.findFirst({
      where: { scope: t.scope, minCny: t.minCny },
    })
    if (existing) {
      await prisma.customLadderTier.update({
        where: { id: existing.id },
        data: { bonusRate: t.bonusRate, sortOrder: t.sortOrder },
      })
    } else {
      await prisma.customLadderTier.create({ data: t })
    }
  }

  // 全局返利规则（单行，id=1）：默认两级返利、企业池消耗计入、无封顶
  await prisma.rebateRule.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, corpCounts: true, maxLayers: 2 },
  })

  return {
    teamPlans: TEAM_PLANS.length,
    teamPacks: TEAM_PACKS.length,
    ladderTiers: CUSTOM_LADDER_TIERS.length,
  }
}
