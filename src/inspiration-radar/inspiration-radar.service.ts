import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import { ApifyMediaItem, ApifyProvider } from "../common/providers/apify.provider"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { CreateSubscriptionDto, Platform } from "./dto/create-subscription.dto"
import { UpdateSubscriptionDto } from "./dto/update-subscription.dto"

const MAX_SUBSCRIPTIONS = 5

const COST_PER_RESULT: Record<string, number> = {
  PINTEREST: 0.00199 * 3,
  INSTAGRAM: 0.0015 * 3,
  TIKTOK: 0.0017 * 3,
}

@Injectable()
export class InspirationRadarService {
  private readonly logger = new Logger(InspirationRadarService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly apify: ApifyProvider,
    private readonly usage: UsageService
  ) {}

  // ==================== 订阅 CRUD ====================

  async create(dto: CreateSubscriptionDto, userId: number) {
    const count = await this.prisma.inspirationSubscription.count({
      where: { userId },
    })
    if (count >= MAX_SUBSCRIPTIONS) {
      throw new BadRequestException(`订阅数量已达上限（最多 ${MAX_SUBSCRIPTIONS} 个）`)
    }

    return this.prisma.inspirationSubscription.create({
      data: {
        userId,
        name: dto.name,
        keywords: dto.keywords,
        keywordVariants: dto.keywordVariants ?? undefined,
        selectedVariants: dto.selectedVariants ?? undefined,
        platforms: dto.platforms,
        countPerPlatform: dto.countPerPlatform,
      },
    })
  }

  async findAll(userId: number) {
    const subs = await this.prisma.inspirationSubscription.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { items: true } } },
    })
    return subs.map(s => ({
      id: s.id,
      name: s.name,
      keywords: s.keywords,
      keywordVariants: s.keywordVariants,
      selectedVariants: s.selectedVariants,
      platforms: s.platforms,
      countPerPlatform: s.countPerPlatform,
      lastRefreshedAt: s.lastRefreshedAt,
      itemCount: s._count.items,
      createdAt: s.createdAt,
    }))
  }

  async update(id: number, dto: UpdateSubscriptionDto, userId: number) {
    await this.assertOwned(id, userId)
    return this.prisma.inspirationSubscription.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.keywords !== undefined && { keywords: dto.keywords }),
        ...(dto.keywordVariants !== undefined && { keywordVariants: dto.keywordVariants }),
        ...(dto.selectedVariants !== undefined && { selectedVariants: dto.selectedVariants }),
        ...(dto.platforms !== undefined && { platforms: dto.platforms }),
        ...(dto.countPerPlatform !== undefined && { countPerPlatform: dto.countPerPlatform }),
      },
    })
  }

  async remove(id: number, userId: number) {
    await this.assertOwned(id, userId)
    await this.prisma.inspirationItem.deleteMany({ where: { subscriptionId: id } })
    await this.prisma.inspirationSubscription.update({
      where: { id },
      data: { deletedAt: new Date() },
    })
    return { success: true }
  }

  // ==================== 刷新 ====================

  async refresh(id: number, userId: number) {
    const sub = await this.assertOwned(id, userId)

    const platforms = sub.platforms as Platform[]
    const keywords = sub.keywords as string[]
    const countMap = sub.countPerPlatform as Record<string, number>

    const searchKeywords = this.buildSearchKeywords(
      keywords,
      sub.selectedVariants as Record<string, string[]> | null
    )

    const fetches: Promise<ApifyMediaItem[]>[] = []
    for (const platform of platforms) {
      const count = countMap[platform] ?? 30
      if (platform === "PINTEREST") fetches.push(this.apify.searchPinterest(searchKeywords, count))
      if (platform === "INSTAGRAM") fetches.push(this.apify.searchInstagram(searchKeywords, count))
      if (platform === "TIKTOK") fetches.push(this.apify.searchTikTok(searchKeywords, count))
    }

    const results = (await Promise.all(fetches)).flat()

    await this.chargeApifyCost(userId, results, { id: sub.id, name: sub.name })

    await this.prisma.$transaction(async tx => {
      await tx.inspirationItem.deleteMany({ where: { subscriptionId: id } })
      if (results.length > 0) {
        await tx.inspirationItem.createMany({
          data: results.map(item => ({
            subscriptionId: id,
            platform: item.platform,
            mediaType: item.mediaType,
            mediaUrl: item.mediaUrl,
            thumbnailUrl: item.thumbnailUrl,
            sourceUrl: item.sourceUrl,
            title: item.title,
            likes: item.likes,
            comments: item.comments,
            saves: item.saves,
            views: item.views,
            durationSec: item.durationSec,
            authorName: item.authorName,
            authorUrl: item.authorUrl,
            externalId: item.externalId,
          })),
          skipDuplicates: true,
        })
      }
      await tx.inspirationSubscription.update({
        where: { id },
        data: { lastRefreshedAt: new Date() },
      })
    })

    this.logger.log(
      `[InspirationRadar] 刷新完成 subId=${id} 结果数=${results.length}`
    )

    return this.findItems(id, userId)
  }

  async refreshAll(userId: number) {
    const subs = await this.prisma.inspirationSubscription.findMany({
      where: { userId },
      select: { id: true },
    })
    const results = await Promise.all(subs.map(s => this.refresh(s.id, userId)))
    return { refreshed: subs.length, totalItems: results.reduce((a, r) => a + r.length, 0) }
  }

  // ==================== 结果查询 ====================

  async findItems(id: number, userId: number, mediaType?: string) {
    await this.assertOwned(id, userId)
    return this.prisma.inspirationItem.findMany({
      where: {
        subscriptionId: id,
        ...(mediaType && { mediaType }),
      },
      orderBy: { likes: "desc" },
    })
  }

  // ==================== 私有 ====================

  private async chargeApifyCost(
    userId: number,
    results: ApifyMediaItem[],
    subscription: { id: number; name: string }
  ) {
    if (results.length === 0) return

    let totalCostCny = new Decimal(0)
    const breakdown: Record<string, number> = {}

    for (const item of results) {
      const rate = COST_PER_RESULT[item.platform] ?? 0
      totalCostCny = totalCostCny.add(rate)
      breakdown[item.platform] = (breakdown[item.platform] ?? 0) + 1
    }

    if (totalCostCny.greaterThan(0)) {
      await this.usage.deductCustom(userId, totalCostCny, {
        source: "inspiration_radar.refresh",
        meta: {
          subscriptionId: subscription.id,
          subscriptionName: subscription.name,
          resultCount: results.length,
          breakdown,
        },
      })
      this.logger.log(
        `[InspirationRadar] 扣费 userId=${userId} cost=¥${totalCostCny.toFixed(4)} items=${results.length}`
      )
    }
  }

  /**
   * 构建搜索词：keywords（种子词）∪ selectedVariants 中各 key 的所有值（去重）
   */
  private buildSearchKeywords(
    keywords: string[],
    selectedVariants: Record<string, string[]> | null
  ): string[] {
    const result: string[] = [...keywords]
    if (selectedVariants) {
      for (const variants of Object.values(selectedVariants)) {
        result.push(...variants)
      }
    }
    return [...new Set(result)]
  }

  private async assertOwned(id: number, userId: number) {
    const sub = await this.prisma.inspirationSubscription.findFirst({
      where: { id, userId },
    })
    if (!sub) throw new NotFoundException("订阅不存在")
    return sub
  }
}
