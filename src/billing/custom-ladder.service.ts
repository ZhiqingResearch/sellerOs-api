import { Injectable } from "@nestjs/common"
import { PrismaService } from "../prisma/prisma.service"

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 分钟缓存

export type LadderScope = "PERSONAL" | "TEAM"

/**
 * 自定义充值阶梯（CustomLadderTier 表驱动，个人/团队两套独立阶梯）。
 * 读表 + 5 分钟内存缓存；tier 按 minCny 升序，命中 = 金额 >= 门槛的最高一档。
 */
@Injectable()
export class CustomLadderService {
  private cache = new Map<
    LadderScope,
    { at: number; tiers: { minCny: number; bonusRate: number }[] }
  >()

  constructor(private readonly prisma: PrismaService) {}

  /** 按充值金额（元）取赠送比例（0~1） */
  async bonusRate(scope: LadderScope, amountCny: number): Promise<number> {
    const tiers = await this.tiers(scope)
    let rate = 0
    for (const t of tiers) {
      if (amountCny >= t.minCny) rate = t.bonusRate
      else break
    }
    return rate
  }

  /** 某 scope 的全量阶梯（目录接口下发用），按门槛升序 */
  async tiers(scope: LadderScope): Promise<{ minCny: number; bonusRate: number }[]> {
    const hit = this.cache.get(scope)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tiers
    const rows = await this.prisma.customLadderTier.findMany({
      where: { scope },
      orderBy: { minCny: "asc" },
      select: { minCny: true, bonusRate: true },
    })
    const tiers = rows.map(r => ({ minCny: Number(r.minCny), bonusRate: Number(r.bonusRate) }))
    this.cache.set(scope, { at: Date.now(), tiers })
    return tiers
  }

  invalidate() {
    this.cache.clear()
  }
}
