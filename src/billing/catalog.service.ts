import { getCustomMinCny } from "./billing.constants"
import { Injectable } from "@nestjs/common"
import { CREDIT_PER_CNY } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"
import { CustomLadderService } from "./custom-ladder.service"

/**
 * 商品目录：个人套餐/充值包/团队套餐/团队包/自定义阶梯 + 单价/折扣标签（后端算好下发，前端只渲染）。
 * 价格全部人民币（元）。单价 = 价格 ÷ 合计到账（三位小数）；折扣标签 = 价格 ÷ 划线原价（一位小数折）。
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ladder: CustomLadderService
  ) {}

  async getCatalog() {
    const [plans, packs, teamPlans, teamPacks, personalLadder, teamLadder] = await Promise.all([
      this.prisma.membershipPlan.findMany({ where: { active: true }, orderBy: { tier: "asc" } }),
      this.prisma.rechargePack.findMany({
        where: { active: true },
        orderBy: { sortOrder: "asc" },
      }),
      this.prisma.teamPlan.findMany({ where: { active: true }, orderBy: { tier: "asc" } }),
      this.prisma.teamPack.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } }),
      this.ladder.tiers("PERSONAL"),
      this.ladder.tiers("TEAM"),
    ])

    return {
      customMinCny: getCustomMinCny(),
      creditPerCny: CREDIT_PER_CNY, // 自定义充值换算锚点（1 元 = N 积分）
      plans: plans.map(p => {
        const total = p.packageCredits + p.giftCredits
        const priceCny = Number(p.priceCny)
        const originalPriceCny = p.originalPriceCny != null ? Number(p.originalPriceCny) : null
        return {
          tier: p.tier,
          code: `plan_lv${p.tier}`,
          name: p.name,
          priceCny,
          originalPriceCny,
          packageCredits: p.packageCredits,
          giftCredits: p.giftCredits,
          totalCredits: total,
          periodDays: p.periodDays,
          unitPrice: unitPrice(priceCny, total),
          discountLabel: discountLabel(priceCny, originalPriceCny),
        }
      }),
      packs: packs.map(p => {
        const total = p.baseCredits + p.bonusCredits
        const priceCny = Number(p.priceCny)
        return {
          id: p.id,
          priceCny,
          baseCredits: p.baseCredits,
          bonusCredits: p.bonusCredits,
          totalCredits: total,
          unitPrice: unitPrice(priceCny, total),
        }
      }),
      customLadder: personalLadder, // [{ minCny, bonusRate }]，金额（元）>= 门槛命中
      teamPlans: teamPlans.map(t => {
        const total = t.poolPackageCredits + t.poolGiftCredits
        const priceCny = Number(t.priceCny)
        const originalPriceCny = t.originalPriceCny != null ? Number(t.originalPriceCny) : null
        return {
          tier: t.tier,
          code: t.tier === 1 ? "team_standard" : "team_flagship",
          name: t.name,
          priceCny,
          originalPriceCny,
          seats: t.seats,
          poolPackageCredits: t.poolPackageCredits,
          poolGiftCredits: t.poolGiftCredits,
          totalCredits: total,
          periodDays: t.periodDays,
          unitPrice: unitPrice(priceCny, total),
          discountLabel: discountLabel(priceCny, originalPriceCny),
          poolDiscount: "1.00", // 自助购买共享池折扣固定 1.00
        }
      }),
      teamPacks: teamPacks.map(p => {
        const priceCny = Number(p.priceCny)
        return {
          id: p.id,
          priceCny,
          baseCredits: p.baseCredits,
          bonusCredits: p.bonusCredits,
          totalCredits: p.baseCredits + p.bonusCredits,
          unitPrice: unitPrice(priceCny, p.baseCredits + p.bonusCredits),
        }
      }),
      teamCustomLadder: teamLadder,
    }
  }
}

/** 单价（元/积分，三位小数）：价格 ÷ 合计到账 */
function unitPrice(priceCny: number, totalCredits: number): number | null {
  if (!totalCredits) return null
  return Math.round((priceCny / totalCredits) * 1000) / 1000
}

/** 折扣标签（如 0.9 → "9折"）：价格 ÷ 划线原价；无划线价返回 null */
function discountLabel(priceCny: number | null, originalPriceCny: number | null): string | null {
  if (priceCny == null || originalPriceCny == null || originalPriceCny <= 0) return null
  const zhe = Math.round((priceCny / originalPriceCny) * 100) / 10
  return `${zhe}折`
}
