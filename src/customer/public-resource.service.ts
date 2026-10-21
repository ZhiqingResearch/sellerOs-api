import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import type { Prisma } from "@prisma/client"
import { BaiduXilingProvider } from "src/common/providers/baidu-xiling.provider"
import { PrismaService } from "src/prisma/prisma.service"
import type { QueryPublicAvatarDto, QueryPublicVoiceDto } from "./customer.dto"
import { tagPublicVoice } from "./voice-tagger"

/**
 * 公共形象 / 公共音色管理。
 *
 * 架构说明：
 * - PublicAvatar / PublicVoice 是百度曦灵公共目录的本地镜像表，TTL=24h 刷新
 * - 用户点"添加到客户"时，在 Avatar / Voice 表插入 kind=PUBLIC 行，复制 figureId / perId
 * - 客户已添加的公共资源照现有 findAllAvatars / findAllVoices 返回（status=SUCCESS，自动跳过对账）
 * - 已绑定但被百度下架的资源：PublicAvatar.isActive=false，前端打角标；合成时拦截
 */
@Injectable()
export class PublicResourceService {
  private readonly logger = new Logger(PublicResourceService.name)

  /** 镜像 TTL：24 小时。超过则后台异步刷新，当前请求先返回旧镜像。 */
  private static readonly MIRROR_TTL_MS = 24 * 60 * 60 * 1000

  /** 需要同步的公共形象组件类型（仅视频类；互动直播等不在范围内） */
  private static readonly FIGURE_ITEMS = ["VIDEO-DH_2D", "VIDEO-DH_2D_LITE", "VIDEO-DH_3D"] as const

  /** 进程内互斥：防止并发刷新同时打爆百度 */
  private avatarRefreshing: Promise<void> | null = null
  private voiceRefreshing: Promise<void> | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly baiduXiling: BaiduXilingProvider
  ) {}

  // ==================== 公共形象 ====================

  /**
   * 弹窗 picker：按筛选条件返回公共形象。自动走 TTL 懒刷新。
   * 响应里加一个 syncedAt 给前端提示最近刷新时间。
   */
  async listPublicAvatars(query: QueryPublicAvatarDto) {
    await this.maybeRefreshAvatars(query.refresh === true)

    const page = query.page ?? 1
    const pageSize = Math.min(query.pageSize ?? 20, 100)
    const where: Prisma.PublicAvatarWhereInput = { isActive: true }
    if (query.gender) where.gender = query.gender
    if (query.age) where.age = query.age
    if (query.pose) where.pose = query.pose
    if (query.background) where.background = query.background
    if (query.humanType) where.humanType = query.humanType
    if (query.aspectRatio) where.aspectRatio = query.aspectRatio
    if (query.q) where.name = { contains: query.q }

    const [items, total, syncAgg] = await Promise.all([
      this.prisma.publicAvatar.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.publicAvatar.count({ where }),
      this.prisma.publicAvatar.aggregate({ _max: { syncedAt: true } }),
    ])
    return { items, total, page, pageSize, syncedAt: syncAgg._max.syncedAt }
  }

  /**
   * 把某公共形象添加到客户：在 Avatar 表插入 kind=PUBLIC 行。
   * 若已软删除过同 figureId 的绑定则复活；已存在未删则返回 409。
   */
  async bindAvatarToCustomer(customerId: number, figureId: string, userId: number) {
    await this.ensureCustomerOwnership(customerId, userId)

    const pub = await this.prisma.publicAvatar.findUnique({ where: { figureId } })
    if (!pub) throw new NotFoundException("公共形象不存在")
    if (!pub.isActive) throw new BadRequestException("该公共形象已下架，无法添加")

    // findFirst 能透过软删除过滤器读到软删除行（findUnique 也可以，但这里统一用 findFirst 带 deletedAt: { not: null } 检查复活场景）
    // 先尝试"复活"软删除的旧绑定；没有就新建
    const existing = await this.prisma.avatar.findFirst({
      where: { customerId, figureId },
    })
    if (existing && existing.deletedAt === null) {
      throw new ConflictException("该公共形象已添加到客户")
    }
    if (existing && existing.deletedAt !== null) {
      return this.prisma.avatar.update({
        where: { id: existing.id },
        data: {
          deletedAt: null,
          kind: "PUBLIC",
          status: "SUCCESS",
          name: pub.name,
          gender: this.normalizeAvatarGender(pub.gender),
          thumbnailUrl: pub.templateImg,
        },
      })
    }

    return this.prisma.avatar.create({
      data: {
        customerId,
        kind: "PUBLIC",
        figureId: pub.figureId,
        name: pub.name,
        gender: this.normalizeAvatarGender(pub.gender),
        thumbnailUrl: pub.templateImg,
        status: "SUCCESS",
      },
    })
  }

  // ==================== 公共音色 ====================

  async listPublicVoices(query: QueryPublicVoiceDto) {
    await this.maybeRefreshVoices(query.refresh === true)

    const page = query.page ?? 1
    const pageSize = Math.min(query.pageSize ?? 20, 100)
    const where: Prisma.PublicVoiceWhereInput = { isActive: true }
    if (query.gender) where.gender = query.gender
    if (query.age) where.age = query.age
    if (query.style) where.style = query.style
    if (query.capability) where.capability = query.capability
    if (query.feature) where.feature = query.feature
    if (query.latency) where.latency = query.latency
    if (query.q) {
      where.OR = [{ name: { contains: query.q } }, { describe: { contains: query.q } }]
    }
    // 语言是 JSON 数组，Prisma MySQL 没有 array_contains filter；内存二次过滤即可（目录量小）
    let items = await this.prisma.publicVoice.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: query.language ? 0 : (page - 1) * pageSize,
      take: query.language ? undefined : pageSize,
    })
    if (query.language) {
      items = items.filter(v => {
        const langs = (v.language as string[] | null) ?? []
        return langs.includes(query.language as string)
      })
    }
    const total = query.language ? items.length : await this.prisma.publicVoice.count({ where })
    const paged = query.language ? items.slice((page - 1) * pageSize, page * pageSize) : items

    const syncAgg = await this.prisma.publicVoice.aggregate({ _max: { syncedAt: true } })
    return { items: paged, total, page, pageSize, syncedAt: syncAgg._max.syncedAt }
  }

  async bindVoiceToCustomer(customerId: number, perId: string, userId: number) {
    await this.ensureCustomerOwnership(customerId, userId)

    const pub = await this.prisma.publicVoice.findUnique({ where: { perId } })
    if (!pub) throw new NotFoundException("公共音色不存在")
    if (!pub.isActive) throw new BadRequestException("该公共音色已下架，无法添加")

    const existing = await this.prisma.voice.findFirst({ where: { customerId, perId } })
    if (existing && existing.deletedAt === null) {
      throw new ConflictException("该公共音色已添加到客户")
    }
    if (existing && existing.deletedAt !== null) {
      return this.prisma.voice.update({
        where: { id: existing.id },
        data: {
          deletedAt: null,
          kind: "PUBLIC",
          status: "SUCCESS",
          name: pub.name,
          gender: this.normalizeVoiceGender(pub.gender),
          exampleAudioUrl: pub.exampleAudioUrl,
          description: pub.describe,
        },
      })
    }

    return this.prisma.voice.create({
      data: {
        customerId,
        kind: "PUBLIC",
        perId: pub.perId,
        name: pub.name,
        gender: this.normalizeVoiceGender(pub.gender),
        exampleAudioUrl: pub.exampleAudioUrl,
        description: pub.describe,
        status: "SUCCESS",
      },
    })
  }

  // ==================== TTL 刷新 ====================

  /** 若最近刷新已超过 TTL 或 force=true，触发刷新。force 同步等待；否则 fire-and-forget。 */
  private async maybeRefreshAvatars(force: boolean): Promise<void> {
    const agg = await this.prisma.publicAvatar.aggregate({ _max: { syncedAt: true } })
    const last = agg._max.syncedAt?.getTime() ?? 0
    const stale = Date.now() - last > PublicResourceService.MIRROR_TTL_MS

    if (force || last === 0) {
      await this.refreshAvatars()
      return
    }
    if (stale && !this.avatarRefreshing) {
      this.refreshAvatars().catch(err => {
        this.logger.warn(
          `后台刷新公共形象失败: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }
  }

  private async maybeRefreshVoices(force: boolean): Promise<void> {
    const agg = await this.prisma.publicVoice.aggregate({ _max: { syncedAt: true } })
    const last = agg._max.syncedAt?.getTime() ?? 0
    const stale = Date.now() - last > PublicResourceService.MIRROR_TTL_MS

    if (force || last === 0) {
      await this.refreshVoices()
      return
    }
    if (stale && !this.voiceRefreshing) {
      this.refreshVoices().catch(err => {
        this.logger.warn(
          `后台刷新公共音色失败: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }
  }

  /** 真正执行刷新。进程内互斥避免并发多打一遍百度。 */
  private refreshAvatars(): Promise<void> {
    if (this.avatarRefreshing) return this.avatarRefreshing
    this.avatarRefreshing = this.doRefreshAvatars().finally(() => {
      this.avatarRefreshing = null
    })
    return this.avatarRefreshing
  }

  private async doRefreshAvatars(): Promise<void> {
    const startedAt = Date.now()
    const now = new Date()
    const seen = new Set<string>()

    for (const item of PublicResourceService.FIGURE_ITEMS) {
      try {
        const list = await this.baiduXiling.listPublicFigures(item)
        for (const f of list) {
          if (!f.systemFigure) continue
          seen.add(f.figureId)
          const aspectRatio = this.deriveAspectRatio(f.resolutionWidth, f.resolutionHeight)
          const humanType = this.deriveHumanType(item)
          await this.prisma.publicAvatar.upsert({
            where: { figureId: f.figureId },
            update: {
              name: f.name,
              item,
              gender: f.gender ?? null,
              age: f.age ?? null,
              pose: f.pose ?? null,
              background: f.background ?? null,
              tags: (f.tags ?? null) as Prisma.InputJsonValue,
              templateImg: f.templateImg ?? null,
              templateVideoUrl: f.templateVideoUrl ?? null,
              pictureUrl: f.pictureUrl ?? null,
              maskVideoUrl: f.maskVideoUrl ?? null,
              resolutionWidth: f.resolutionWidth ?? null,
              resolutionHeight: f.resolutionHeight ?? null,
              aspectRatio,
              humanType,
              keepBackground: f.keepBackground ?? null,
              isActive: true,
              syncedAt: now,
            },
            create: {
              figureId: f.figureId,
              name: f.name,
              item,
              gender: f.gender ?? null,
              age: f.age ?? null,
              pose: f.pose ?? null,
              background: f.background ?? null,
              tags: (f.tags ?? null) as Prisma.InputJsonValue,
              templateImg: f.templateImg ?? null,
              templateVideoUrl: f.templateVideoUrl ?? null,
              pictureUrl: f.pictureUrl ?? null,
              maskVideoUrl: f.maskVideoUrl ?? null,
              resolutionWidth: f.resolutionWidth ?? null,
              resolutionHeight: f.resolutionHeight ?? null,
              aspectRatio,
              humanType,
              keepBackground: f.keepBackground ?? null,
              isActive: true,
              syncedAt: now,
            },
          })
        }
      } catch (err) {
        this.logger.warn(
          `刷新公共形象 item=${item} 失败（继续刷其它）: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    // 本轮没出现的置 isActive=false（软失效，不物理删，保留已绑定行的引用追溯）
    if (seen.size > 0) {
      await this.prisma.publicAvatar.updateMany({
        where: { figureId: { notIn: [...seen] }, isActive: true },
        data: { isActive: false },
      })
    }

    this.logger.log(`[公共形象] 刷新完成 size=${seen.size} elapsed=${Date.now() - startedAt}ms`)
  }

  private refreshVoices(): Promise<void> {
    if (this.voiceRefreshing) return this.voiceRefreshing
    this.voiceRefreshing = this.doRefreshVoices().finally(() => {
      this.voiceRefreshing = null
    })
    return this.voiceRefreshing
  }

  private async doRefreshVoices(): Promise<void> {
    const startedAt = Date.now()
    const now = new Date()
    const list = await this.baiduXiling.listPublicVoices()
    const seen = new Set<string>()

    for (const v of list) {
      if (!v.systemProvided) continue
      seen.add(v.perId)
      const tags = tagPublicVoice({ name: v.name, describe: v.describe, version: v.version })
      const data = {
        name: v.name,
        describe: v.describe ?? null,
        version: v.version ?? null,
        gender: v.gender ?? null,
        exampleAudioUrl: v.exampleAudioUrl ?? null,
        age: tags.age ?? null,
        style: tags.style ?? null,
        language: (tags.language ?? null) as Prisma.InputJsonValue,
        capability: tags.capability ?? null,
        feature: tags.feature ?? null,
        latency: tags.latency ?? null,
        isActive: true,
        syncedAt: now,
      }
      await this.prisma.publicVoice.upsert({
        where: { perId: v.perId },
        update: data,
        create: { perId: v.perId, ...data },
      })
    }

    if (seen.size > 0) {
      await this.prisma.publicVoice.updateMany({
        where: { perId: { notIn: [...seen] }, isActive: true },
        data: { isActive: false },
      })
    }

    this.logger.log(`[公共音色] 刷新完成 size=${seen.size} elapsed=${Date.now() - startedAt}ms`)
  }

  // ==================== 工具方法 ====================

  /** 权限：和 CustomerService.findOne 一致的校验（不直接依赖该 service，避免循环依赖） */
  private async ensureCustomerOwnership(customerId: number, userId: number): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { userId: true },
    })
    if (!customer) throw new NotFoundException("客户不存在")
    if (customer.userId !== userId) throw new ForbiddenException("无权访问该客户")
  }

  private deriveAspectRatio(w?: number | null, h?: number | null): string | null {
    if (!w || !h) return null
    if (w === h) return "1:1"
    const r = w / h
    if (Math.abs(r - 16 / 9) < 0.02) return "16:9"
    if (Math.abs(r - 9 / 16) < 0.02) return "9:16"
    if (Math.abs(r - 4 / 3) < 0.02) return "4:3"
    if (Math.abs(r - 3 / 4) < 0.02) return "3:4"
    return `${w}:${h}`
  }

  private deriveHumanType(item: string): "2D" | "3D" | null {
    if (item.includes("3D")) return "3D"
    if (item.includes("2D")) return "2D"
    return null
  }

  /** 百度 avatar gender 可能是 MALE / FEMALE / UNKNOWN，Avatar 表限 MALE/FEMALE，不确定按 FEMALE 兜底 */
  private normalizeAvatarGender(g?: string | null): "MALE" | "FEMALE" {
    const up = (g ?? "").toUpperCase()
    return up === "MALE" ? "MALE" : "FEMALE"
  }

  /** Voice 表的 gender 约定小写 male/female/unknown */
  private normalizeVoiceGender(g?: string | null): string {
    const low = (g ?? "").toLowerCase()
    if (low === "male" || low === "female") return low
    return "unknown"
  }
}
