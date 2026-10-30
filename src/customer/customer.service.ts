import { labelImage } from "../aigc/image-label"
import { deliverVideo } from "../aigc/media-delivery"
import { retryDelivery } from "../aigc/aigc-metadata"
import { SpacesService } from "../spaces/spaces.service"
import { modelDisplayNames, jsonObject, videoMetadata } from "../common/utils/generation-metadata"
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleInit,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Cron, CronExpression } from "@nestjs/schedule"
import {
  AiModelExecMode,
  AiModelModality,
  type Avatar,
  type Prisma,
  ProjectStatus,
  type Script,
  TagCategory,
  type Voice,
} from "@prisma/client"
import type { VideoGenerationRequest } from "@zhiqingresearch/ai-ts-sdk"
import axios from "axios"
import { AiGatewayWebhookService } from "src/ai-gateway/ai-gateway-webhook.service"
import { AiGatewayProvider } from "src/ai-gateway/ai-gateway.provider"
import { moderationBusinessTimeout } from "../content-moderation/task-moderation.service"
import {
  type AvatarWebhookPayload,
  BaiduXilingProvider,
  type VideoWebhookPayload,
  type VoiceWebhookPayload,
} from "src/common/providers/baidu-xiling.provider"
import { GoogleProvider } from "src/common/providers/google.provider"
import { beijingMonthStart } from "src/common/utils/datetime"
import { OssService } from "src/oss/oss.service"
import { PrismaService } from "src/prisma/prisma.service"
import { UsageService } from "src/usage/usage.service"
import { fixedVideoRequestCredits, sumFixedVideoCredits } from "src/usage/video-fixed-pricing"
import {
  CreateAccountDto,
  CreateAvatarDto,
  CreateCustomerDto,
  CreateProjectDto,
  CreateSourceDto,
  CreateStrategyDto,
  CreateVoiceDto,
  type GenerateMaterialVariantsItemDto,
  type GenerateStoryboardVideoItemDto,
  QueryCustomerDto,
  QueryGlobalProjectDto,
  QueryProjectDto,
  type SynthesizeVideoDto,
  UpdateAccountDto,
  UpdateCustomerDto,
} from "./customer.dto"
import {
  ACCOUNT_STRATEGY_SYSTEM_PROMPT,
  type AccountInfo,
  buildAccountStrategyPrompt,
  buildContentPlanPrompt,
  buildCopyWritingPrompt,
  buildCustomerStrategyPrompt,
  buildHotspotsPrompt,
  buildMaterialPrompt,
  buildScriptPrompt,
  buildStoryboardPrompt,
  CONTENT_PLAN_SYSTEM_PROMPT,
  type ContentPlan,
  COPYWRITING_SYSTEM_PROMPT,
  CUSTOMER_STRATEGY_SYSTEM_PROMPT,
  type CustomerInfo,
  HOTSPOTS_SYSTEM_PROMPT,
  type HotspotsResult,
  MATERIAL_SYSTEM_PROMPT,
  type MaterialItem,
  SCRIPT_SYSTEM_PROMPT,
  STORYBOARD_SYSTEM_PROMPT,
  type StoryboardItem,
} from "./customer.prompts"

/** 简单并发节流：保持最多 `limit` 个任务同时跑，失败不抛（启动对账场景下单条失败应继续推进其余条目） */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<unknown>
): Promise<void> {
  if (!items.length) return
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      await fn(items[idx]).catch(() => {})
    }
  })
  await Promise.all(workers)
}

@Injectable()
export class CustomerService implements OnModuleInit {
  private readonly logger = new Logger(CustomerService.name)

  /** fire-and-forget 任务的单次墙钟超时（10 分钟） */
  private static readonly ASYNC_TASK_TIMEOUT_MS = 10 * 60 * 1000
  private static readonly STORYBOARD_VIDEO_TIMEOUT_MS = 30 * 60 * 1000
  /** 启动时扫描"孤儿 GENERATING"的阈值：`updatedAt` 早于 15 分钟前视为上一轮进程残留 */
  private static readonly STARTUP_STALE_THRESHOLD_MS = 15 * 60 * 1000
  /** 曦灵读时对账节流：同一行 2 分钟内不会重复调百度 query */
  private static readonly XILING_RECONCILE_THROTTLE_MS = 2 * 60 * 1000
  /** 数字人视频 OSS 转存节流：同一 scriptId 30 分钟内不重复发起转存 */
  private static readonly VIDEO_PERSIST_THROTTLE_MS = 30 * 60 * 1000
  /** 定时转存 cron 单次最多扫多少行 baidu-URL 的 Script（避免单批阻塞过久） */
  private static readonly VIDEO_PERSIST_CRON_BATCH = 10
  /** 定时转存 cron 同时下载/上传的并发上限（每个视频流式约 10MB，3 并发 ≈ 30MB 峰值） */
  private static readonly VIDEO_PERSIST_CRON_CONCURRENCY = 3

  /** 记录每个 scriptId 最近一次 OSS 转存尝试时间，用于节流（进程内内存即可，重启由 cron 兜底） */
  private readonly videoPersistAttempts = new Map<number, number>()
  /** cron 自防重入：上一次任务还没跑完，本次直接跳过 */
  private videoPersistCronRunning = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleProvider,
    private readonly oss: OssService,
    private readonly baiduXiling: BaiduXilingProvider,
    private readonly config: ConfigService,
    private readonly gateway: AiGatewayProvider,
    private readonly gatewayWebhook: AiGatewayWebhookService,
    private readonly usage: UsageService,
    private readonly spaces: SpacesService
  ) {}

  /**
   * 进程启动时：
   * - 本地驱动的孤儿任务（Nano Banana/Deep Research）直接标 FAILED，因为对应的 Promise 已随进程丢失
   * - 分镜视频由 AI Gateway 模块负责启动对账
   * - 曦灵任务（形象/音色/视频合成）由百度在跑，可能只是 webhook 丢失；主动调 query 对账拿真实状态
   */
  async onModuleInit() {
    const cutoff = new Date(Date.now() - CustomerService.STARTUP_STALE_THRESHOLD_MS)
    const reason = "进程重启导致任务中断"

    const [variantResult, sourceResult, stuckAvatars, stuckVoices, stuckScripts] =
      await Promise.all([
        this.prisma.materialImageVariant.updateMany({
          where: { status: "GENERATING", deletedAt: null, updatedAt: { lt: cutoff } },
          data: { status: "FAILED", errorMessage: reason },
        }),
        this.prisma.source.updateMany({
          where: {
            type: "DEEP_RESEARCH",
            status: "GENERATING",
            deletedAt: null,
            updatedAt: { lt: cutoff },
          },
          data: { status: "FAILED", errorMessage: reason },
        }),
        this.prisma.avatar.findMany({
          where: { status: "GENERATING", figureId: { not: null }, deletedAt: null },
        }),
        this.prisma.voice.findMany({
          where: { status: "GENERATING", perId: { not: null }, deletedAt: null },
        }),
        this.prisma.script.findMany({
          where: { videoStatus: "GENERATING", videoTaskId: { not: null }, deletedAt: null },
        }),
      ])

    // 曦灵对账与本地清理并行，失败不阻断启动
    await Promise.all([
      ...stuckAvatars.map(a => this.reconcileAvatar(a, { throttle: false })),
      ...stuckVoices.map(v => this.reconcileVoice(v, { throttle: false })),
      ...stuckScripts.map(s => this.reconcileScriptVideo(s, { throttle: false })),
    ])

    // 数字人视频的 OSS 转存兜底改为 @Cron 定时任务（持续转存 baidu-URL → OSS），
    // 不再在启动时一次性 fire，避免重启→大量并发转存→OOM 的死循环。

    if (
      variantResult.count > 0 ||
      sourceResult.count > 0 ||
      stuckAvatars.length > 0 ||
      stuckVoices.length > 0 ||
      stuckScripts.length > 0
    ) {
      this.logger.log(
        `[启动恢复] 本地清理：materialImageVariant=${variantResult.count} deepResearchSource=${sourceResult.count}；曦灵对账：avatar=${stuckAvatars.length} voice=${stuckVoices.length} video=${stuckScripts.length}`
      )
    }
  }

  // ==================== 统计 ====================

  async getStats(userId: number) {
    const ownerScope = { customer: { userId } }
    const [customers, accounts, avatars, projects] = await Promise.all([
      this.prisma.customer.count({ where: { userId } }),
      this.prisma.account.count({ where: ownerScope }),
      this.prisma.avatar.count({ where: ownerScope }),
      this.prisma.project.count({ where: ownerScope }),
    ])
    return { customers, accounts, avatars, projects }
  }

  /** 社媒运营员工作台卡片：已完成 / 已发布 / 发布率 / Token / 累计生成内容 */
  async getDashboardStats(userId: number) {
    const now = new Date()
    const startOfMonth = beijingMonthStart(now) // 本月口径：北京自然月
    const completedStatuses = [ProjectStatus.COMPLETED, ProjectStatus.PUBLISHED]
    const byUser = { customer: { userId } }
    const byUserProduction = { production: { project: { customer: { userId } } } }

    const [
      completedProjects,
      completedDeltaThisMonth,
      publishedProjects,
      scriptCount,
      copyWritingCount,
      storyboardVideoCount,
      materialImageVariantCount,
    ] = await Promise.all([
      this.prisma.project.count({ where: { status: { in: completedStatuses }, ...byUser } }),
      this.prisma.project.count({
        where: { status: { in: completedStatuses }, updatedAt: { gte: startOfMonth }, ...byUser },
      }),
      this.prisma.project.count({ where: { status: ProjectStatus.PUBLISHED, ...byUser } }),
      this.prisma.script.count({ where: byUserProduction }),
      this.prisma.copyWriting.count({ where: byUserProduction }),
      this.prisma.storyboardVideo.count({
        where: {
          status: "SUCCESS",
          storyboard: { production: { project: { customer: { userId } } } },
        },
      }),
      this.prisma.materialImageVariant.count({
        where: {
          status: "SUCCESS",
          materialImage: { production: { project: { customer: { userId } } } },
        },
      }),
    ])

    return {
      completedProjects,
      completedDeltaThisMonth,
      publishedProjects,
      publishRate:
        completedProjects > 0 ? Number((publishedProjects / completedProjects).toFixed(2)) : 0,
      tokenUsage: 0,
      totalContents:
        scriptCount + copyWritingCount + storyboardVideoCount + materialImageVariantCount,
    }
  }

  // ==================== 全局项目列表 ====================

  async findAllProjectsGlobal(query: QueryGlobalProjectDto, userId: number) {
    const { page, pageSize, status } = query
    const where: Prisma.ProjectWhereInput = {
      customer: { userId },
      ...(status && { status }),
    }

    const [items, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              user: { select: { id: true, username: true } },
            },
          },
          account: { select: { id: true, name: true, platform: true } },
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.project.count({ where }),
    ])

    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }

  // ==================== 归属校验 ====================

  /** 客户归属校验：不存在 404，非本人创建 403。 */
  private async ensureCustomerOwnership(customerId: number, userId: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { userId: true },
    })
    if (!customer) throw new NotFoundException("客户不存在")
    if (customer.userId !== userId) throw new ForbiddenException("无权访问该客户")
  }

  private async ensureAccountOwnership(accountId: number, userId: number) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { customer: { select: { userId: true } } },
    })
    if (!account) throw new NotFoundException("账号不存在")
    if (account.customer.userId !== userId) throw new ForbiddenException("无权访问该账号")
  }

  private async ensureAvatarOwnership(avatarId: number, userId: number) {
    const avatar = await this.prisma.avatar.findUnique({
      where: { id: avatarId },
      select: { customer: { select: { userId: true } } },
    })
    if (!avatar) throw new NotFoundException("形象不存在")
    if (avatar.customer.userId !== userId) throw new ForbiddenException("无权访问该形象")
  }

  private async ensureVoiceOwnership(voiceId: number, userId: number) {
    const voice = await this.prisma.voice.findUnique({
      where: { id: voiceId },
      select: { customer: { select: { userId: true } } },
    })
    if (!voice) throw new NotFoundException("音色不存在")
    if (voice.customer.userId !== userId) throw new ForbiddenException("无权访问该音色")
  }

  private async ensureProjectOwnership(projectId: number, userId: number) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { customer: { select: { userId: true } } },
    })
    if (!project) throw new NotFoundException("项目不存在")
    if (project.customer.userId !== userId) throw new ForbiddenException("无权访问该项目")
  }

  private async ensureProductionOwnership(productionId: number, userId: number) {
    const production = await this.prisma.production.findUnique({
      where: { id: productionId },
      select: { project: { select: { customer: { select: { userId: true } } } } },
    })
    if (!production) throw new NotFoundException("生产层不存在")
    if (production.project.customer.userId !== userId)
      throw new ForbiddenException("无权访问该生产层")
  }

  private async ensureStoryboardOwnership(id: number, userId: number) {
    const row = await this.prisma.storyboard.findUnique({
      where: { id },
      select: {
        production: { select: { project: { select: { customer: { select: { userId: true } } } } } },
      },
    })
    if (!row) throw new NotFoundException("分镜头不存在")
    if (row.production.project.customer.userId !== userId)
      throw new ForbiddenException("无权访问该分镜头")
  }

  private async ensureStoryboardVideoOwnership(id: number, userId: number) {
    const row = await this.prisma.storyboardVideo.findUnique({
      where: { id },
      select: {
        storyboard: {
          select: {
            production: {
              select: { project: { select: { customer: { select: { userId: true } } } } },
            },
          },
        },
      },
    })
    if (!row) throw new NotFoundException("席位视频不存在")
    if (row.storyboard.production.project.customer.userId !== userId)
      throw new ForbiddenException("无权访问该席位视频")
  }

  private async ensureMaterialOwnership(id: number, userId: number) {
    const row = await this.prisma.materialImage.findUnique({
      where: { id },
      select: {
        production: { select: { project: { select: { customer: { select: { userId: true } } } } } },
      },
    })
    if (!row) throw new NotFoundException("素材不存在")
    if (row.production.project.customer.userId !== userId)
      throw new ForbiddenException("无权访问该素材")
  }

  private async ensureMaterialVariantOwnership(id: number, userId: number) {
    const row = await this.prisma.materialImageVariant.findUnique({
      where: { id },
      select: {
        materialImage: {
          select: {
            production: {
              select: { project: { select: { customer: { select: { userId: true } } } } },
            },
          },
        },
      },
    })
    if (!row) throw new NotFoundException("素材变体不存在")
    if (row.materialImage.production.project.customer.userId !== userId)
      throw new ForbiddenException("无权访问该素材变体")
  }

  // ==================== 客户 ====================

  async create(dto: CreateCustomerDto, userId: number) {
    await this.ensureTags(TagCategory.INDUSTRY, dto.industry)
    await this.ensureTags(TagCategory.PLATFORM, dto.platforms)

    const customer = await this.prisma.customer.create({ data: { ...dto, userId } })

    // 异步生成运营方案，不阻塞创建响应
    this.generateStrategy(customer.id, dto).catch((err: Error) =>
      this.logger.error(`生成运营方案失败 [客户ID: ${customer.id}]: ${err.message}`)
    )

    return customer
  }

  /** 重新生成客户运营方案（同步等待） */
  async regenerateStrategy(id: number, userId: number) {
    await this.ensureCustomerOwnership(id, userId)
    const customer = await this.findOne(id)
    await this.generateStrategy(customer.id, customer)
    return await this.findOne(id)
  }

  /** 重新生成账号规划方案（同步等待） */
  async regenerateAccountStrategy(id: number, userId: number) {
    await this.ensureAccountOwnership(id, userId)
    const account = await this.findOneAccount(id)
    const customer = await this.findOne(account.customerId)
    await this.generateAccountStrategy(account.id, customer, account)
    return await this.findOneAccount(id)
  }

  /** 调用 Gemini 生成运营方案并回写 */
  private async generateStrategy(customerId: number, customer: CustomerInfo) {
    const strategy = await this.google.generateText(
      CUSTOMER_STRATEGY_SYSTEM_PROMPT,
      buildCustomerStrategyPrompt(customer)
    )

    if (strategy) {
      await this.prisma.customer.update({
        where: { id: customerId },
        data: { strategy },
      })
      this.logger.log(`运营方案生成完成 [客户ID: ${customerId}]`)
    }
  }

  async findAll(query: QueryCustomerDto, userId: number) {
    const { name, industry } = query
    const where: Prisma.CustomerWhereInput = {
      userId,
      ...(name && { name: { contains: name } }),
      ...(industry && { industry: { array_contains: industry } }),
    }

    const list = await this.prisma.customer.findMany({
      where,
      include: {
        _count: {
          select: {
            accounts: { where: { deletedAt: null } },
            projects: { where: { deletedAt: null } },
            avatars: { where: { deletedAt: null } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    })

    return list.map(({ _count, ...rest }) => ({
      ...rest,
      accountCount: _count.accounts,
      projectCount: _count.projects,
      avatarCount: _count.avatars,
    }))
  }

  /** 查客户。传 userId 时额外校验归属（公共接口用）；不传则纯取数（内部使用）。 */
  async findOne(id: number, userId?: number) {
    const customer = await this.prisma.customer.findUnique({ where: { id } })
    if (!customer) throw new NotFoundException("客户不存在")
    if (userId !== undefined && customer.userId !== userId)
      throw new ForbiddenException("无权访问该客户")
    return customer
  }

  async update(id: number, dto: UpdateCustomerDto, userId: number) {
    await this.ensureCustomerOwnership(id, userId)

    if (dto.industry) {
      await this.ensureTags(TagCategory.INDUSTRY, dto.industry)
    }
    if (dto.platforms) {
      await this.ensureTags(TagCategory.PLATFORM, dto.platforms)
    }

    return await this.prisma.customer.update({ where: { id }, data: dto })
  }

  // ==================== 账号 ====================

  async createAccount(customerId: number, dto: CreateAccountDto, userId: number) {
    const customer = await this.findOne(customerId, userId)
    await this.ensureTags(TagCategory.PLATFORM, [dto.platform])
    if (dto.accountStyle) {
      await this.ensureTags(TagCategory.ACCOUNT_STYLE, [dto.accountStyle])
    }

    const account = await this.prisma.account.create({ data: { ...dto, customerId } })

    // 异步生成账号规划方案，不阻塞创建响应
    this.generateAccountStrategy(account.id, customer, dto).catch((err: Error) =>
      this.logger.error(`生成账号规划方案失败 [账号ID: ${account.id}]: ${err.message}`)
    )

    return account
  }

  async findAllAccounts(customerId: number, userId: number) {
    await this.findOne(customerId, userId)
    return await this.prisma.account.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
    })
  }

  async findOneAccount(id: number, userId?: number) {
    if (userId !== undefined) await this.ensureAccountOwnership(id, userId)
    const account = await this.prisma.account.findUnique({ where: { id } })
    if (!account) throw new NotFoundException("账号不存在")
    return account
  }

  async updateAccount(id: number, dto: UpdateAccountDto, userId: number) {
    await this.findOneAccount(id, userId)

    if (dto.platform) {
      await this.ensureTags(TagCategory.PLATFORM, [dto.platform])
    }
    if (dto.accountStyle) {
      await this.ensureTags(TagCategory.ACCOUNT_STYLE, [dto.accountStyle])
    }

    return await this.prisma.account.update({ where: { id }, data: dto })
  }

  async removeAccount(id: number, userId: number) {
    await this.findOneAccount(id, userId)
    const now = new Date()
    const productionDescendant = {
      production: { project: { accountId: id } },
      deletedAt: null,
    }
    const projectDescendant = { project: { accountId: id }, deletedAt: null }
    await this.prisma.$transaction([
      this.prisma.storyboardVideo.updateMany({
        where: {
          storyboard: { production: { project: { accountId: id } } },
          deletedAt: null,
        },
        data: { deletedAt: now },
      }),
      this.prisma.materialImageVariant.updateMany({
        where: {
          materialImage: { production: { project: { accountId: id } } },
          deletedAt: null,
        },
        data: { deletedAt: now },
      }),
      this.prisma.script.updateMany({ where: productionDescendant, data: { deletedAt: now } }),
      this.prisma.copyWriting.updateMany({ where: productionDescendant, data: { deletedAt: now } }),
      this.prisma.storyboard.updateMany({ where: productionDescendant, data: { deletedAt: now } }),
      this.prisma.materialImage.updateMany({
        where: productionDescendant,
        data: { deletedAt: now },
      }),
      this.prisma.production.updateMany({ where: projectDescendant, data: { deletedAt: now } }),
      this.prisma.source.updateMany({ where: projectDescendant, data: { deletedAt: now } }),
      this.prisma.strategy.updateMany({ where: projectDescendant, data: { deletedAt: now } }),
      this.prisma.project.updateMany({
        where: { accountId: id, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.account.update({ where: { id }, data: { deletedAt: now } }),
    ])
  }

  /** 调用 Gemini 生成账号规划方案并回写 */
  private async generateAccountStrategy(
    accountId: number,
    customer: CustomerInfo,
    account: AccountInfo
  ) {
    const strategy = await this.google.generateText(
      ACCOUNT_STRATEGY_SYSTEM_PROMPT,
      buildAccountStrategyPrompt(customer, account)
    )

    if (strategy) {
      await this.prisma.account.update({
        where: { id: accountId },
        data: { strategy },
      })
      this.logger.log(`账号规划方案生成完成 [账号ID: ${accountId}]`)
    }
  }

  // ==================== 形象 ====================

  /**
   * 颁发曦灵文件上传接口的签名，供前端直接 POST 到 uploadUrl 上传形象训练视频。
   * 上传请求需要 multipart/form-data 字段：file、providerType=OPEN_CUSTOMIZATION_2D_GENERAL、sourceFileName。
   * 音色克隆仍由后端代上传（走 /customer/:customerId/voice 直接传 trainingUrl）。
   */
  getXilingUploadAuth() {
    const { authorization, expireAt } = this.baiduXiling.generateAuth()
    return { authorization, uploadUrl: this.baiduXiling.getUploadEndpoint(), expireAt }
  }

  async createAvatar(customerId: number, dto: CreateAvatarDto, userId: number) {
    await this.findOne(customerId, userId)

    const figureId = await this.baiduXiling.createAvatar({
      fileId: dto.fileId,
      trainingUrl: dto.trainingUrl,
      name: dto.name,
      gender: dto.gender,
      callbackUrl: `${this.config.get<string>("API_BASE_URL")}/api/customer/webhook/avatar`,
    })

    const { fileId: _fileId, ...rest } = dto
    return await this.prisma.avatar.create({
      data: { ...rest, figureId, customerId },
    })
  }

  /** 软删除形象。已引用该形象的 Script 不级联删除（历史合成视频保留）。 */
  async removeAvatar(id: number, userId: number) {
    await this.ensureAvatarOwnership(id, userId)
    await this.prisma.avatar.update({ where: { id }, data: { deletedAt: new Date() } })
  }

  async findAllAvatars(
    customerId: number,
    userId: number,
    status?: "GENERATING" | "SUCCESS" | "FAILED"
  ) {
    await this.findOne(customerId, userId)
    const avatars = await this.prisma.avatar.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
    })
    // 克隆行走对账；公共行 status 已是 SUCCESS，reconcileAvatar 会 early-return
    const reconciled = await Promise.all(avatars.map(a => this.reconcileAvatar(a)))

    // 公共行 LEFT JOIN PublicAvatar 补字段（templateVideoUrl / pose / background / isActive 等）
    const publicFigureIds = reconciled
      .filter(a => a.kind === "PUBLIC" && a.figureId)
      .map(a => a.figureId as string)
    const pubMap =
      publicFigureIds.length > 0
        ? new Map(
            (
              await this.prisma.publicAvatar.findMany({
                where: { figureId: { in: publicFigureIds } },
              })
            ).map(p => [p.figureId, p])
          )
        : new Map()

    const enriched = reconciled.map(a => {
      if (a.kind !== "PUBLIC" || !a.figureId) return { ...a, publicMeta: null }
      const pub = pubMap.get(a.figureId)
      return {
        ...a,
        publicMeta: pub
          ? {
              templateImg: pub.templateImg,
              templateVideoUrl: pub.templateVideoUrl,
              pose: pub.pose,
              background: pub.background,
              humanType: pub.humanType,
              aspectRatio: pub.aspectRatio,
              resolutionWidth: pub.resolutionWidth,
              resolutionHeight: pub.resolutionHeight,
              tags: pub.tags,
              isActive: pub.isActive,
            }
          : { isActive: false }, // 百度整个把 figureId 删了的极端情况：按下架处理
      }
    })

    return status ? enriched.filter(a => a.status === status) : enriched
  }

  // ==================== 音色 ====================

  async createVoice(customerId: number, dto: CreateVoiceDto, userId: number) {
    await this.findOne(customerId, userId)

    const { data: audioBuffer } = await axios.get<Buffer>(dto.trainingUrl, {
      responseType: "arraybuffer",
    })

    const perId = await this.baiduXiling.createVoiceClone({
      audioBuffer: Buffer.from(audioBuffer),
      audioFileName: dto.trainingUrl.split("/").pop() ?? "audio.wav",
      name: dto.name,
      gender: dto.gender,
      exampleText: dto.exampleText,
      describe: dto.description,
      callbackUrl: `${this.config.get<string>("API_BASE_URL")}/api/customer/webhook/voice`,
    })

    return await this.prisma.voice.create({
      data: { ...dto, perId, customerId },
    })
  }

  /** 软删除音色。已引用该音色的 Script 不级联删除（历史合成视频保留）。 */
  async removeVoice(id: number, userId: number) {
    await this.ensureVoiceOwnership(id, userId)
    await this.prisma.voice.update({ where: { id }, data: { deletedAt: new Date() } })
  }

  async findAllVoices(
    customerId: number,
    userId: number,
    status?: "GENERATING" | "SUCCESS" | "FAILED"
  ) {
    await this.findOne(customerId, userId)
    const voices = await this.prisma.voice.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
    })
    const reconciled = await Promise.all(voices.map(v => this.reconcileVoice(v)))

    // 公共行 LEFT JOIN PublicVoice 补启发式标签 + 下架标记
    const publicPerIds = reconciled
      .filter(v => v.kind === "PUBLIC" && v.perId)
      .map(v => v.perId as string)
    const pubMap =
      publicPerIds.length > 0
        ? new Map(
            (
              await this.prisma.publicVoice.findMany({
                where: { perId: { in: publicPerIds } },
              })
            ).map(p => [p.perId, p])
          )
        : new Map()

    const enriched = reconciled.map(v => {
      if (v.kind !== "PUBLIC" || !v.perId) return { ...v, publicMeta: null }
      const pub = pubMap.get(v.perId)
      return {
        ...v,
        publicMeta: pub
          ? {
              describe: pub.describe,
              version: pub.version,
              age: pub.age,
              style: pub.style,
              language: pub.language,
              capability: pub.capability,
              feature: pub.feature,
              latency: pub.latency,
              isActive: pub.isActive,
            }
          : { isActive: false },
      }
    })

    return status ? enriched.filter(v => v.status === status) : enriched
  }

  // ==================== Webhook 回调 / 对账 ====================

  /**
   * 统一形象状态落库；webhook 和对账共用。
   * 曦灵的 WAIT/LINE_UP/GENERATING 都视为"进行中"，SUCCESS/FAILED 透传。
   *
   * 注：Avatar 表的 unique 从 figureId 改为 (customerId, figureId) 后，
   * 单独用 figureId 不能走 update（非 unique），改用 updateMany 并约束 kind='CLONED' —— 公共行永远不会收到 webhook 或对账，不会被误改。
   * 克隆 figureId 由曦灵保证跨客户不重复，所以 updateMany 实际只会命中一行。
   */
  private async applyAvatarStatus(
    figureId: string,
    rawStatus: string,
    thumbnailUrl?: string | null,
    failureReason?: string | null
  ) {
    const status: "GENERATING" | "SUCCESS" | "FAILED" =
      rawStatus === "SUCCESS" || rawStatus === "FAILED" ? rawStatus : "GENERATING"

    await this.prisma.avatar.updateMany({
      where: { figureId, kind: "CLONED" },
      data: { status, ...(thumbnailUrl && { thumbnailUrl }) },
    })

    if (status === "FAILED") {
      this.logger.error(`数字人训练失败 [figureId: ${figureId}]: ${failureReason ?? "unknown"}`)
    }
  }

  /**
   * 统一音色状态落库；曦灵的 FAIL 归一成 FAILED，查询接口可能返回"进行中"状态则归为 GENERATING。
   * 同 applyAvatarStatus：perId 从全局 unique 改为 (customerId, perId) 复合 unique 后，
   * 用 updateMany + kind='CLONED' 防误改公共行（公共行不会命中 webhook/对账，这里只是双保险）。
   */
  private async applyVoiceStatus(
    perId: string,
    rawStatus: string,
    exampleAudioUrl?: string | null,
    failureReason?: string | null
  ) {
    const status: "GENERATING" | "SUCCESS" | "FAILED" =
      rawStatus === "SUCCESS"
        ? "SUCCESS"
        : rawStatus === "FAIL" || rawStatus === "FAILED"
          ? "FAILED"
          : "GENERATING"

    await this.prisma.voice.updateMany({
      where: { perId, kind: "CLONED" },
      data: { status, ...(exampleAudioUrl && { exampleAudioUrl }) },
    })

    if (status === "FAILED") {
      this.logger.error(`声音克隆失败 [perId: ${perId}]: ${failureReason ?? "unknown"}`)
    }
  }

  /**
   * 统一视频合成状态落库；曦灵的 SUBMIT/GENERATING 归并为 GENERATING。
   * SUCCESS 时如果 videoUrl 还是百度临时链接，fire-and-forget 起后台任务
   * 把视频下载并转存到 OSS（百度 URL 仅保留 7 天）。
   */
  private async applyVideoStatus(
    taskId: string,
    rawStatus: string,
    videoUrl?: string | null,
    duration?: number | null,
    failedMessage?: string | null
  ) {
    const status: "GENERATING" | "SUCCESS" | "FAILED" =
      rawStatus === "SUCCESS" || rawStatus === "FAILED" ? rawStatus : "GENERATING"

    if (status === "SUCCESS") {
      if (!videoUrl) throw new ServiceUnavailableException("视频生成结果缺少文件地址")
      videoUrl = await deliverVideo(this.spaces, videoUrl, `xiling:${taskId}`)
    }
    const script = await this.prisma.script.update({
      where: { videoTaskId: taskId },
      data:
        status === "SUCCESS"
          ? {
              videoStatus: "SUCCESS",
              videoUrl: videoUrl ?? undefined,
              videoDuration: duration ?? undefined,
              videoErrorMessage: null,
            }
          : status === "FAILED"
            ? { videoStatus: "FAILED", videoErrorMessage: failedMessage ?? null }
            : { videoStatus: "GENERATING" },
    })

    if (status === "FAILED") {
      this.logger.error(`视频合成失败 [taskId: ${taskId}]: ${failedMessage ?? "unknown"}`)
    }

    if (status === "SUCCESS") {
      this.tryPersistScriptVideo(script.id, script.videoUrl)
    }
  }

  /** 判断 URL 是否已是我们 OSS 上的地址（用于幂等防重复上传） */
  private isOssUrl(url: string): boolean {
    const base = this.config.get<string>("OSS_BASE_URL") ?? ""
    return !!base && url.startsWith(base.replace(/\/$/, ""))
  }

  /**
   * 尝试发起一次 OSS 转存（fire-and-forget）：
   * - URL 为空或已是 OSS 域名 → 跳过（幂等）
   * - 30 分钟内已尝试过 → 跳过（节流，避免读时触发被高频读爆）
   */
  /**
   * 定时扫描 SUCCESS 但 videoUrl 仍指向百度的 Script，分批转存到 OSS。
   *
   * 为什么是 cron 而不是启动时一次性扫：
   * - 启动时一次性 fire N 个 baidu→OSS 转存 → 进程内存 N × 300MB（旧 Buffer 方案）或 N × 10MB（流式）；
   *   若失败导致 OOM 重启，重启后又会重新扫到同一批 → 死循环。
   * - cron + 小批量 + 严格并发上限 把这条链拆成"细水长流"，单批失败也不会拖崩进程。
   *
   * 节流：单批最多 VIDEO_PERSIST_CRON_BATCH 行（10），并发 VIDEO_PERSIST_CRON_CONCURRENCY（3）。
   * 防重入：cron 自带 `videoPersistCronRunning` 锁，上一轮没跑完本轮直接 skip。
   * 触发 `tryPersistScriptVideo` 而非直接调 `persistScriptVideoToOss`，复用 30 分钟节流避免与
   * webhook 路径的转存撞车。
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async cronPersistPendingVideos() {
    if (this.videoPersistCronRunning) {
      this.logger.debug("[VideoPersistCron] 上一轮还在跑，跳过")
      return
    }
    this.videoPersistCronRunning = true
    try {
      const ossBase = (this.config.get<string>("OSS_BASE_URL") ?? "").replace(/\/$/, "")
      const pending = await this.prisma.script.findMany({
        where: {
          videoStatus: "SUCCESS",
          deletedAt: null,
          AND: [
            { videoUrl: { not: null } },
            ...(ossBase ? [{ NOT: { videoUrl: { startsWith: ossBase } } }] : []),
          ],
        },
        orderBy: { updatedAt: "asc" },
        take: CustomerService.VIDEO_PERSIST_CRON_BATCH,
      })
      if (!pending.length) return
      this.logger.log(`[VideoPersistCron] 本轮扫到 ${pending.length} 条待转存`)
      // 直接同步 await persistScriptVideoToOss，由 runWithConcurrency 控制并发；
      // 不走 tryPersistScriptVideo 的 fire-and-forget 路径，否则并发上限失效。
      await runWithConcurrency(pending, CustomerService.VIDEO_PERSIST_CRON_CONCURRENCY, async s => {
        if (!s.videoUrl || this.isOssUrl(s.videoUrl)) return
        // 同时更新内存节流戳，防止 webhook 路径在 cron 处理期间重复发起
        this.videoPersistAttempts.set(s.id, Date.now())
        await this.persistScriptVideoToOss(s.id, s.videoUrl)
      })
    } catch (err) {
      this.logger.error(
        `[VideoPersistCron] 异常: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      this.videoPersistCronRunning = false
    }
  }

  private tryPersistScriptVideo(scriptId: number, videoUrl: string | null | undefined) {
    if (!videoUrl || this.isOssUrl(videoUrl)) return
    const last = this.videoPersistAttempts.get(scriptId) ?? 0
    if (Date.now() - last < CustomerService.VIDEO_PERSIST_THROTTLE_MS) return
    this.videoPersistAttempts.set(scriptId, Date.now())
    this.persistScriptVideoToOss(scriptId, videoUrl).catch((err: Error) => {
      this.logger.error(`数字人视频转存 OSS 后台任务异常 [scriptId=${scriptId}]: ${err.message}`)
    })
  }

  /**
   * 后台任务：下载百度视频 → 上传 OSS → 回写 Script.videoUrl。
   * 失败时仅记日志，DB 保留原百度 URL；下次 reconcile 到 SUCCESS 还会再试。
   */
  private async persistScriptVideoToOss(scriptId: number, baiduUrl: string) {
    const tag = `[XilingVideo→OSS scriptId=${scriptId}]`
    try {
      this.logger.log(`${tag} 开始流式下载 ${baiduUrl.slice(0, 80)}...`)
      // 流式直传：百度 → 本地 socket → ali-oss putStream，整段视频不进 Node 堆
      const resp = await axios.get<NodeJS.ReadableStream>(baiduUrl, {
        responseType: "stream",
        timeout: 120000,
      })
      const lenHeader = resp.headers["content-length"]
      const contentLength =
        typeof lenHeader === "string" ? Number.parseInt(lenHeader, 10) : undefined

      const key = `xiling-video/${scriptId}/${Date.now()}.mp4`
      const ossUrl = await this.oss.uploadStream(
        resp.data as unknown as import("stream").Readable,
        key,
        "video/mp4",
        Number.isFinite(contentLength) ? contentLength : undefined
      )

      await this.prisma.script.update({
        where: { id: scriptId },
        data: { videoUrl: ossUrl },
      })
      this.logger.log(`${tag} 成功 ✓ ossUrl=${ossUrl}`)
    } catch (err) {
      this.logger.error(
        `${tag} 转存失败: ${err instanceof Error ? err.message : String(err)}（保留百度 URL，等下次对账重试）`
      )
    }
  }

  /**
   * 主动拉取曦灵最新状态并落库，避免 webhook 丢失导致 GENERATING 卡死。
   * `throttle=true` 时同一行 2 分钟内不会重复调百度 query；启动时对账传 false 强制查一次。
   */
  private async reconcileAvatar(
    avatar: Avatar,
    opts: { throttle?: boolean } = {}
  ): Promise<Avatar> {
    const { throttle = true } = opts
    if (avatar.status !== "GENERATING" || !avatar.figureId) return avatar
    if (
      throttle &&
      Date.now() - avatar.updatedAt.getTime() < CustomerService.XILING_RECONCILE_THROTTLE_MS
    ) {
      return avatar
    }
    try {
      const info = await this.baiduXiling.queryAvatar(avatar.figureId)
      if (!info.status) throw new Error("查询数字人状态为空")
      await this.applyAvatarStatus(
        avatar.figureId,
        info.status,
        info.status === "SUCCESS" ? info.templateImg : undefined
      )
      return (await this.prisma.avatar.findUnique({ where: { id: avatar.id } })) ?? avatar
    } catch (err) {
      this.logger.warn(
        `Avatar 对账失败 [figureId=${avatar.figureId}]: ${err instanceof Error ? err.message : String(err)}`
      )
      return avatar
    }
  }

  private async reconcileVoice(voice: Voice, opts: { throttle?: boolean } = {}): Promise<Voice> {
    const { throttle = true } = opts
    if (voice.status !== "GENERATING" || !voice.perId) return voice
    if (
      throttle &&
      Date.now() - voice.updatedAt.getTime() < CustomerService.XILING_RECONCILE_THROTTLE_MS
    ) {
      return voice
    }
    try {
      const info = await this.baiduXiling.queryVoiceClone(voice.perId, false)
      await this.applyVoiceStatus(voice.perId, info.status, info.exampleAudioUrl, info.reason)
      return (await this.prisma.voice.findUnique({ where: { id: voice.id } })) ?? voice
    } catch (err) {
      this.logger.warn(
        `Voice 对账失败 [perId=${voice.perId}]: ${err instanceof Error ? err.message : String(err)}`
      )
      return voice
    }
  }

  private async reconcileScriptVideo(
    script: Script,
    opts: { throttle?: boolean } = {}
  ): Promise<Script> {
    const { throttle = true } = opts
    if (script.videoStatus !== "GENERATING" || !script.videoTaskId) return script
    if (
      throttle &&
      Date.now() - script.updatedAt.getTime() < CustomerService.XILING_RECONCILE_THROTTLE_MS
    ) {
      return script
    }
    try {
      const info = await this.baiduXiling.queryVideoTask(script.videoTaskId)
      await this.applyVideoStatus(
        script.videoTaskId,
        info.status,
        info.videoUrl,
        info.duration,
        info.failedMessage
      )
      return (await this.prisma.script.findUnique({ where: { id: script.id } })) ?? script
    } catch (err) {
      this.logger.warn(
        `Video 对账失败 [taskId=${script.videoTaskId}]: ${err instanceof Error ? err.message : String(err)}`
      )
      return script
    }
  }

  async handleAvatarWebhook(body: AvatarWebhookPayload) {
    const { figureId, status: raw, failedMessage } = body.data
    this.logger.log(
      `[AvatarWebhook] figureId=${figureId} raw=${raw} failedMessage=${failedMessage ?? "-"}`
    )
    // Avatar.figureId 不再是全局 unique，改用 findFirst 并锁 kind=CLONED（公共行不会走训练回调）
    const avatar = await this.prisma.avatar.findFirst({ where: { figureId, kind: "CLONED" } })
    if (!avatar) {
      this.logger.warn(`Avatar webhook: 未找到 figureId=${figureId}`)
      return
    }
    const thumbnailUrl =
      raw === "SUCCESS" ? (await this.baiduXiling.queryAvatar(figureId)).templateImg : undefined
    await this.applyAvatarStatus(figureId, raw, thumbnailUrl, failedMessage)
  }

  async handleVoiceWebhook(body: VoiceWebhookPayload) {
    const { perId, status: raw, exampleAudioUrl, reason } = body.data
    this.logger.log(`[VoiceWebhook] perId=${perId} raw=${raw} reason=${reason ?? "-"}`)
    const voice = await this.prisma.voice.findFirst({ where: { perId, kind: "CLONED" } })
    if (!voice) {
      this.logger.warn(`Voice webhook: 未找到 perId=${perId}`)
      return
    }
    await this.applyVoiceStatus(perId, raw, exampleAudioUrl, reason)
  }

  // ==================== 项目 ====================

  async createProject(customerId: number, dto: CreateProjectDto, userId: number) {
    await this.findOne(customerId, userId)
    await this.findOneAccount(dto.accountId, userId)

    return await this.prisma.project.create({
      data: { ...dto, customerId },
    })
  }

  async findAllProjects(customerId: number, query: QueryProjectDto, userId: number) {
    await this.findOne(customerId, userId)
    const { page, pageSize, name, status, accountId } = query
    const where: Prisma.ProjectWhereInput = {
      customerId,
      ...(name && { name: { contains: name } }),
      ...(status && { status }),
      ...(accountId && { accountId }),
    }

    const [items, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        include: { account: true },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.project.count({ where }),
    ])

    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }

  async findOneProject(id: number, userId?: number) {
    if (userId !== undefined) await this.ensureProjectOwnership(id, userId)
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        account: true,
        customer: true,
        source: { where: { deletedAt: null } },
        strategy: { where: { deletedAt: null } },
        production: {
          where: { deletedAt: null },
          include: {
            scripts: {
              where: { deletedAt: null },
              orderBy: { createdAt: "desc" },
              include: { avatar: true, voice: true },
            },
          },
        },
      },
    })
    if (!project) {
      throw new NotFoundException("项目不存在")
    }
    // 读时兜底：若有 Script 视频还未转存 OSS，fire-and-forget 起一次转存（30 分钟节流）
    for (const s of project.production?.scripts ?? []) this.tryPersistScriptVideo(s.id, s.videoUrl)
    if (project.production) {
      const names = await modelDisplayNames(this.prisma, project.production.scripts.map(s => jsonObject(s.videoMeta).modelPublicId))
      Object.assign(project.production, { scripts: project.production.scripts.map(s => { const meta = jsonObject(s.videoMeta); return { ...s,
        mode: s.videoTaskId ? "DIGITAL_HUMAN" : null, modelPublicId: meta.modelPublicId ?? null,
        displayName: names.get(meta.modelPublicId) ?? meta.engineName ?? (s.videoTaskId ? "百度曦灵" : null),
        actualDurationSec: s.videoDuration != null ? s.videoDuration / 1000 : null,
        requestedWidth: meta.requestedWidth ?? null, requestedHeight: meta.requestedHeight ?? null } }) })
    }
    return project
  }

  /**
   * 标记项目为已发布。
   * - COMPLETED / PUBLISHED 状态均可调用（支持重复发布以覆盖发布时间或发布链接）
   * - publishedAt / publishUrl 未传则保留原值，传了则覆盖
   */
  async publishProject(id: number, userId: number, publishedAt?: string, publishUrl?: string) {
    const project = await this.findOneProject(id, userId)
    if (project.status !== ProjectStatus.COMPLETED && project.status !== ProjectStatus.PUBLISHED) {
      throw new BadRequestException("项目未完成，无法发布")
    }
    return await this.prisma.project.update({
      where: { id },
      data: {
        status: ProjectStatus.PUBLISHED,
        ...(publishedAt !== undefined && { publishedAt: new Date(publishedAt) }),
        ...(publishUrl !== undefined && { publishUrl }),
      },
    })
  }

  /**
   * 检查项目是否具备"已完成"四件套（口播稿、发布文案、素材图片提示词、分镜头提示词），
   * 是则从 PRODUCING 推进到 COMPLETED。
   * 仅在四项都有至少一条记录 **且** 当前状态为 PRODUCING 时推进，避免回退已发布项目。
   */
  private async maybeCompleteProject(projectId: number) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { production: true },
    })
    if (!project || !project.production) return
    if (project.status !== ProjectStatus.PRODUCING) return

    const productionId = project.production.id
    const [scripts, copies, materials, storyboards] = await Promise.all([
      this.prisma.script.count({ where: { productionId } }),
      this.prisma.copyWriting.count({ where: { productionId } }),
      this.prisma.materialImage.count({ where: { productionId } }),
      this.prisma.storyboard.count({ where: { productionId } }),
    ])

    if (scripts > 0 && copies > 0 && materials > 0 && storyboards > 0) {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.COMPLETED },
      })
      this.logger.log(`[项目 ${projectId}] 四项内容齐备，状态 PRODUCING → COMPLETED`)
    }
  }

  /** 修改项目主题：同时更新 project.name 和 production.topic（保留两者一致） */
  async updateProjectTopic(projectId: number, topic: string, userId: number) {
    await this.ensureProjectOwnership(projectId, userId)
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { production: true },
    })
    if (!project) throw new NotFoundException("项目不存在")
    if (!project.production) throw new NotFoundException("该项目下没有生产层")

    const [updatedProject] = await this.prisma.$transaction([
      this.prisma.project.update({
        where: { id: projectId },
        data: { name: topic },
      }),
      this.prisma.production.update({
        where: { id: project.production.id },
        data: { topic },
      }),
    ])
    return updatedProject
  }

  async removeProject(id: number, userId: number) {
    await this.ensureProjectOwnership(id, userId)
    const now = new Date()
    const productionDescendant = { production: { projectId: id }, deletedAt: null }
    await this.prisma.$transaction([
      this.prisma.storyboardVideo.updateMany({
        where: { storyboard: { production: { projectId: id } }, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.materialImageVariant.updateMany({
        where: { materialImage: { production: { projectId: id } }, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.script.updateMany({ where: productionDescendant, data: { deletedAt: now } }),
      this.prisma.copyWriting.updateMany({ where: productionDescendant, data: { deletedAt: now } }),
      this.prisma.storyboard.updateMany({ where: productionDescendant, data: { deletedAt: now } }),
      this.prisma.materialImage.updateMany({
        where: productionDescendant,
        data: { deletedAt: now },
      }),
      this.prisma.production.updateMany({
        where: { projectId: id, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.source.updateMany({
        where: { projectId: id, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.strategy.updateMany({
        where: { projectId: id, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.project.update({ where: { id }, data: { deletedAt: now } }),
    ])
  }

  // ==================== 深度调研（挂在 Source 上，项目级异步） ====================

  /**
   * 启动一次深度调研（异步，项目级）：
   * 1. upsert Source 行（type=DEEP_RESEARCH, status=GENERATING, content=""）并把 query 落库
   * 2. 若当前 project.status = DRAFT 则同步推进到 PRODUCING；COMPLETED/PUBLISHED 保持不变，
   *    避免把已完成或已发布的项目回退到 PRODUCING 后再被 maybeCompleteProject 误推回 COMPLETED
   * 3. fire-and-forget 调 Gemini Deep Research
   * 4. 立即返回当前 source 快照，前端用 GET /customer/project/:projectId/deep-search 轮询
   * 同一 project 再次调用会覆盖上一次结果（旧任务若晚于新任务完成，会因 sourceId 不匹配丢弃结果）。
   */
  async startDeepResearch(projectId: number, query: string, userId: number) {
    await this.ensureProjectOwnership(projectId, userId)
    const project = await this.prisma.project.findUnique({ where: { id: projectId } })
    if (!project) throw new NotFoundException("项目不存在")

    const [source] = await this.prisma.$transaction([
      this.prisma.source.upsert({
        where: { projectId },
        create: {
          type: "DEEP_RESEARCH",
          content: "",
          query,
          status: "GENERATING",
          errorMessage: null,
          projectId,
        },
        update: {
          type: "DEEP_RESEARCH",
          content: "",
          query,
          status: "GENERATING",
          errorMessage: null,
          deletedAt: null,
        },
      }),
      ...(project.status === ProjectStatus.DRAFT
        ? [
            this.prisma.project.update({
              where: { id: projectId },
              data: { status: ProjectStatus.PRODUCING },
            }),
          ]
        : []),
    ])

    const activeTaskId = source.id
    this.runDeepResearch(activeTaskId, query).catch((err: Error) => {
      this.logger.error(`Deep Research 任务异常 [sourceId=${activeTaskId}]: ${err.message}`)
    })

    return source
  }

  /** 查询某项目深度调研状态（供前端轮询），若 source 不是 DEEP_RESEARCH 类型返回 null */
  async findLatestDeepResearch(projectId: number, userId: number) {
    await this.ensureProjectOwnership(projectId, userId)
    const source = await this.prisma.source.findUnique({ where: { projectId } })
    if (!source || source.type !== "DEEP_RESEARCH") return null
    return source
  }

  /**
   * 后台任务：调 Gemini Deep Research（内部轮询）→ 回写 Source。
   * 写回前用 sourceId 比对当前 Source.id，若 Source 已被覆盖为新的 DEEP_RESEARCH
   * 任务或切换到其他 type，则丢弃结果。
   */
  private async runDeepResearch(sourceId: number, query: string) {
    const tag = `[DeepResearch sourceId=${sourceId}]`
    const startedAt = Date.now()
    this.logger.log(`${tag} 开始 queryHead="${query.slice(0, 60)}..."`)

    const writeIfCurrent = async (
      patch: Partial<{ status: string; content: string; errorMessage: string | null }>
    ) => {
      const current = await this.prisma.source.findUnique({ where: { id: sourceId } })
      if (!current || current.type !== "DEEP_RESEARCH") {
        this.logger.warn(`${tag} Source 已失效或被切换类型，丢弃结果`)
        return
      }
      await this.prisma.source.update({ where: { id: sourceId }, data: patch })
    }

    try {
      const result = await this.google.deepSearch(query)
      if (!result) {
        await writeIfCurrent({ status: "FAILED", errorMessage: "Deep Research 未返回结果" })
        this.logger.error(`${tag} 失败: Deep Research 未返回结果`)
        return
      }
      await writeIfCurrent({ status: "SUCCESS", content: result, errorMessage: null })
      this.logger.log(
        `${tag} 成功 ✓ 长度=${result.length} 总耗时=${((Date.now() - startedAt) / 1000).toFixed(1)}s`
      )
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      await writeIfCurrent({ status: "FAILED", errorMessage: message })
      this.logger.error(`${tag} 失败: ${message}`)
    }
  }

  /**
   * 搜索匹配热点：结合项目所属客户 + 账号画像，调 Gemini（带 Google Search 工具）检索近 7 天热点。
   * 同步阻塞等待返回，解析 JSON 后原样返回给前端（前端用于在来源层挑选一条作为 HOT_TOPIC）。
   */
  async searchHotspots(projectId: number, userId: number): Promise<HotspotsResult> {
    const project = await this.findOneProject(projectId, userId)
    const coreKeywords = Array.isArray(project.account.coreKeywords)
      ? project.account.coreKeywords.map(String)
      : []

    const industry = Array.isArray(project.customer.industry)
      ? project.customer.industry.map(String).join("、")
      : ""
    const userPrompt = buildHotspotsPrompt({
      customerName: project.customer.name,
      industry,
      contentFocus: project.customer.contentFocus,
      coreKeywords,
      targetPositioning: project.account.targetPositioning ?? "",
      avoidTopics: project.customer.avoidTopics ?? "",
    })

    const raw = await this.google.generateTextWithSearch(HOTSPOTS_SYSTEM_PROMPT, userPrompt)
    if (!raw) throw new NotFoundException("热点搜索未返回结果，请稍后重试")

    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start < 0 || end <= start) {
      this.logger.error(`热点搜索结果未包含 JSON 对象：${raw.slice(0, 200)}`)
      throw new NotFoundException("AI 返回内容格式异常，未找到 JSON 对象")
    }
    try {
      return JSON.parse(raw.slice(start, end + 1)) as HotspotsResult
    } catch {
      this.logger.error(`热点搜索 JSON 解析失败：${raw.slice(start, end + 1).slice(0, 200)}`)
      throw new NotFoundException("AI 返回内容格式异常，无法解析 JSON")
    }
  }

  // ==================== 来源 ====================

  async saveSource(projectId: number, dto: CreateSourceDto, userId: number) {
    await this.ensureProjectOwnership(projectId, userId)
    const project = await this.prisma.project.findUnique({ where: { id: projectId } })
    if (!project) throw new NotFoundException("项目不存在")

    // 手动提交的 source 一律重置异步字段为完成态，防止从深度调研切出去后
    // 旧的 GENERATING/FAILED 状态或过期 query 残留。
    const resetAsync = { status: "SUCCESS", query: null, errorMessage: null }

    // 只在 DRAFT 时推进到 PRODUCING；COMPLETED/PUBLISHED 保持原状态，避免退档
    const [source] = await this.prisma.$transaction([
      this.prisma.source.upsert({
        where: { projectId },
        create: { ...dto, ...resetAsync, projectId },
        update: { ...dto, ...resetAsync, deletedAt: null },
      }),
      ...(project.status === ProjectStatus.DRAFT
        ? [
            this.prisma.project.update({
              where: { id: projectId },
              data: { status: ProjectStatus.PRODUCING },
            }),
          ]
        : []),
    ])
    return source
  }

  // ==================== 方案 ====================

  async saveStrategy(projectId: number, dto: CreateStrategyDto, userId: number) {
    await this.ensureProjectOwnership(projectId, userId)
    const project = await this.prisma.project.findUnique({ where: { id: projectId } })
    if (!project) throw new NotFoundException("项目不存在")

    const plan = this.parseContentPlan(dto.content)

    const [strategy] = await this.prisma.$transaction([
      this.prisma.strategy.upsert({
        where: { projectId },
        create: { ...dto, projectId },
        update: { ...dto, deletedAt: null },
      }),
      this.prisma.production.upsert({
        where: { projectId },
        create: { topic: plan.topic, projectId },
        update: { topic: plan.topic, deletedAt: null },
      }),
      this.prisma.project.update({
        where: { id: projectId },
        data: { name: plan.topic },
      }),
    ])

    return strategy
  }

  /** AI 一键生成方案内容，返回给前端 */
  async generateContentPlan(
    projectId: number,
    integrationType: string,
    targetDurationSec: number,
    userId: number
  ) {
    await this.ensureProjectOwnership(projectId, userId)
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { customer: true, account: true, source: true },
    })
    if (!project) throw new NotFoundException("项目不存在")
    if (!project.source) {
      throw new NotFoundException("该项目下没有来源素材，无法生成方案")
    }

    const result = await this.google.generateText(
      CONTENT_PLAN_SYSTEM_PROMPT,
      buildContentPlanPrompt(
        project.customer,
        project.account,
        [{ type: project.source.type, content: project.source.content }],
        { integrationType, targetDurationSec }
      )
    )

    if (!result) throw new NotFoundException("AI 生成方案失败，请稍后重试")
    return { content: result }
  }

  // ==================== 生产层 AI 生成 ====================

  /**
   * AI 生成口播稿：
   * - isAuto=true 时若已有口播稿则直接返回，不调用 AI
   * - 否则调 AI 重新生成；最新一条若未合成视频（videoTaskId 为 null）则覆盖，否则新建以保留历史版本
   */
  async generateScript(projectId: number, isAuto: boolean, userId: number) {
    await this.ensureProjectOwnership(projectId, userId)
    const strategy = await this.prisma.strategy.findUnique({
      where: { projectId },
      include: {
        project: {
          include: { customer: true, account: true, production: true },
        },
      },
    })
    if (!strategy) throw new NotFoundException("该项目下没有方案")
    if (!strategy.project.production) throw new NotFoundException("该项目下没有生产层")

    const productionId = strategy.project.production.id
    const latest = await this.prisma.script.findFirst({
      where: { productionId },
      orderBy: { createdAt: "desc" },
    })

    if (isAuto && latest) {
      await this.maybeCompleteProject(projectId)
      return latest
    }

    const plan = this.parseContentPlan(strategy.content)
    const result = await this.google.generateText(
      SCRIPT_SYSTEM_PROMPT,
      buildScriptPrompt(
        strategy.project.customer,
        strategy.project.account,
        plan,
        strategy.targetDurationSec
      )
    )
    if (!result) throw new NotFoundException("AI 生成口播稿失败，请稍后重试")

    const script =
      latest && !latest.videoTaskId
        ? await this.prisma.script.update({
            where: { id: latest.id },
            data: { content: result },
          })
        : await this.prisma.script.create({
            data: { content: result, productionId },
          })

    await this.maybeCompleteProject(projectId)
    return script
  }

  /**
   * AI 生成发布文案：
   * - isAuto=true 时若已有发布文案则直接返回，不调用 AI
   * - 否则调 AI 重新生成并覆盖原有文案（每个项目只保留一条）
   */
  async generateCopyWriting(projectId: number, isAuto: boolean, userId: number) {
    await this.ensureProjectOwnership(projectId, userId)
    const strategy = await this.prisma.strategy.findUnique({
      where: { projectId },
      include: {
        project: {
          include: { customer: true, account: true, production: true },
        },
      },
    })
    if (!strategy) throw new NotFoundException("该项目下没有方案")
    if (!strategy.project.production) throw new NotFoundException("该项目下没有生产层")

    const productionId = strategy.project.production.id
    const existing = await this.prisma.copyWriting.findFirst({ where: { productionId } })

    if (isAuto && existing) {
      await this.maybeCompleteProject(projectId)
      return existing
    }

    const plan = this.parseContentPlan(strategy.content)
    const result = await this.google.generateText(
      COPYWRITING_SYSTEM_PROMPT,
      buildCopyWritingPrompt(strategy.project.customer, strategy.project.account, plan)
    )
    if (!result) throw new NotFoundException("AI 生成发布文案失败，请稍后重试")

    const parsed = this.parseJsonBlock<{ title: string; body: string; tags: string[] }>(result)
    const data = {
      title: parsed.title,
      content: parsed.body,
      tags: parsed.tags.join(" "),
    }

    const copyWriting = existing
      ? await this.prisma.copyWriting.update({ where: { id: existing.id }, data })
      : await this.prisma.copyWriting.create({ data: { ...data, productionId } })

    await this.maybeCompleteProject(projectId)
    return copyWriting
  }

  // ==================== 分镜头 ====================

  private static readonly STORYBOARD_DEFAULT_COUNT = 3
  private static readonly STORYBOARD_MAX_COUNT = 5
  private static readonly STORYBOARD_SLOT_COUNT = 2

  /** 平台 → Veo 视频分镜头宽高比（Veo 仅支持 16:9 / 9:16） */
  private static readonly PLATFORM_VIDEO_RATIO: Record<string, string> = {
    抖音: "9:16",
    视频号: "9:16",
    快手: "9:16",
    TikTok: "9:16",
    小红书: "9:16",
    B站: "16:9",
  }

  /** AI 生成分镜头（默认 3 个）；已有分镜头则直接返回，不覆盖 */
  async generateStoryboards(projectId: number, userId: number) {
    await this.ensureProjectOwnership(projectId, userId)
    const strategy = await this.prisma.strategy.findUnique({
      where: { projectId },
      include: {
        project: {
          include: { customer: true, production: true },
        },
      },
    })
    if (!strategy) throw new NotFoundException("该项目下没有方案")
    if (!strategy.project.production) throw new NotFoundException("该项目下没有生产层")

    const productionId = strategy.project.production.id

    const existingCount = await this.prisma.storyboard.count({ where: { productionId } })
    if (existingCount === 0) {
      const plan = this.parseContentPlan(strategy.content)
      const shotCount = CustomerService.STORYBOARD_DEFAULT_COUNT

      const result = await this.google.generateText(
        STORYBOARD_SYSTEM_PROMPT,
        buildStoryboardPrompt(strategy.project.customer, plan, shotCount)
      )
      if (!result) throw new NotFoundException("AI 生成分镜头失败，请稍后重试")

      const items = this.parseJsonBlock<StoryboardItem[]>(result).slice(0, shotCount)

      await this.prisma.$transaction(
        items.map((item, i) =>
          this.prisma.storyboard.create({
            data: {
              shot: item.shot,
              duration: item.duration,
              prompt: item.prompt,
              motion: item.motion,
              order: i,
              productionId,
            },
          })
        )
      )
    }

    await this.maybeCompleteProject(projectId)

    return this.presentMedia(await this.prisma.storyboard.findMany({
      where: { productionId },
      include: { videos: { where: { deletedAt: null } } },
      orderBy: [{ order: "asc" }, { id: "asc" }],
    }))
  }

  /** 新增一个空白分镜头（前端填写表单后再调用生成接口触发 Veo，校验 ≤ 5） */
  async createStoryboard(projectId: number, userId: number) {
    await this.ensureProjectOwnership(projectId, userId)
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { production: true },
    })
    if (!project) throw new NotFoundException("项目不存在")
    if (!project.production) throw new NotFoundException("该项目下没有生产层")
    const productionId = project.production.id

    const count = await this.prisma.storyboard.count({ where: { productionId } })
    if (count >= CustomerService.STORYBOARD_MAX_COUNT) {
      throw new BadRequestException(`分镜头已达上限 ${CustomerService.STORYBOARD_MAX_COUNT} 个`)
    }

    return await this.prisma.storyboard.create({
      data: {
        shot: "",
        prompt: "",
        motion: "",
        order: count,
        productionId,
      },
    })
  }

  /** 删除分镜头（软删除，同时级联删除席位视频）；生成中的席位先尽力取消网关任务止损 */
  async removeStoryboard(id: number, userId: number) {
    await this.ensureStoryboardOwnership(id, userId)
    const now = new Date()

    const generating = await this.prisma.storyboardVideo.findMany({
      where: { storyboardId: id, status: "GENERATING", deletedAt: null },
      select: { id: true, gatewayTaskId: true },
    })
    // 尽力取消：失败不阻塞删除（429/抖动场景下未取消的任务，回调会被软删过滤拦下，不再扣费）
    await Promise.allSettled(
      generating
        .filter(video => video.gatewayTaskId)
        .map(async video => {
          try {
            await this.gateway.cancelVideoTask(video.gatewayTaskId as string)
          } catch (error) {
            this.logger.warn(
              `[分镜视频] 删除分镜时取消网关任务失败 video=${video.id}: ${(error as Error).message}`
            )
          }
        })
    )

    await this.prisma.$transaction([
      // 生成中的席位标记取消后软删：即使后续取消/终态回调到达也只会被 CAS 安静拒绝
      this.prisma.storyboardVideo.updateMany({
        where: { storyboardId: id, deletedAt: null, status: "GENERATING" },
        data: { deletedAt: now, status: "CANCELLED", errorMessage: "分镜已删除，取消生成" },
      }),
      this.prisma.storyboardVideo.updateMany({
        where: { storyboardId: id, deletedAt: null, status: { not: "GENERATING" } },
        data: { deletedAt: now },
      }),
      this.prisma.storyboard.update({ where: { id }, data: { deletedAt: now } }),
    ])
  }

  /** 按 ID 批量查询分镜头（含席位视频，供前端批量轮询状态） */
  async findStoryboardsByIds(ids: number[], userId: number) {
    await Promise.all(ids.map(id => this.ensureStoryboardOwnership(id, userId)))

    // 读时对账：轮询时对 GENERATING 席位视频顺带查网关（Gateway 回调丢失时自愈）；
    // 拿到网关权威结论（含仍在 running）的行不进下面的本地墙钟超时
    const generating = await this.prisma.storyboardVideo.findMany({
      where: { storyboardId: { in: ids }, status: { in: ["GENERATING", "WAITING_MODERATION"] }, deletedAt: null },
      select: { id: true, status: true, gatewayTaskId: true },
    })
    const authoritative = new Set<number>()
    await Promise.all(
      generating.map(async video => {
        if (await this.gatewayWebhook.reconcileStoryboardVideoOnRead(video)) {
          authoritative.add(video.id)
        }
      })
    )

    await this.prisma.storyboardVideo.updateMany({
      where: {
        storyboardId: { in: ids },
        status: "GENERATING",
        ...moderationBusinessTimeout(new Date(Date.now() - CustomerService.STORYBOARD_VIDEO_TIMEOUT_MS)),
        deletedAt: null,
        ...(authoritative.size ? { id: { notIn: [...authoritative] } } : {}),
      },
      data: { status: "TIMEOUT", errorMessage: "视频生成超时" },
    })
    return this.presentMedia(await this.prisma.storyboard.findMany({
      where: { id: { in: ids } },
      include: { videos: { where: { deletedAt: null }, orderBy: { id: "asc" } } },
      orderBy: [{ order: "asc" }, { id: "asc" }],
    }))
  }

  /** 批量创建分镜视频席位并提交 AI Gateway，结果由回调写入。 */
  async generateStoryboardVideos(items: GenerateStoryboardVideoItemDto[], userId: number) {
    const ids = items.map(i => i.id)
    await Promise.all(ids.map(id => this.ensureStoryboardOwnership(id, userId)))
    this.logger.log(`[分镜头批量生成] 收到 ${items.length} 条请求 ids=${ids.join(",")}`)

    const existingList = await this.prisma.storyboard.findMany({
      where: { id: { in: ids } },
      include: {
        videos: { where: { deletedAt: null } },
        production: { include: { project: { include: { account: true } } } },
      },
    })
    const existingMap = new Map(existingList.map(s => [s.id, s]))
    const missing = ids.filter(id => !existingMap.has(id))
    if (missing.length) {
      throw new NotFoundException(`分镜头不存在: ${missing.join(", ")}`)
    }

    const model = await this.prisma.aiGatewayModel.findFirst({
      where: {
        category: "STORYBOARD",
        modality: AiModelModality.VIDEO,
        execMode: AiModelExecMode.ASYNC,
        enabled: true,
        gatewayActive: true,
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { publicId: true, priceMultiplier: true },
    })
    if (!model) throw new BadRequestException("客户分镜视频模型未启用")

    const jobs = items.flatMap(item => {
      const existing = existingMap.get(item.id)!
      if (existing.videos.some(video => video.status === "GENERATING")) {
        throw new BadRequestException(`分镜头 ${item.id} 的视频正在生成，请稍后再试`)
      }
      const needCount =
        CustomerService.STORYBOARD_SLOT_COUNT - existing.videos.filter(v => v.approved).length
      if (needCount <= 0) {
        this.logger.warn(`分镜头 ${item.id} 所有席位已被采纳，跳过生成`)
        return []
      }
      const platform = existing.production.project.account.platform
      const aspectRatio = CustomerService.PLATFORM_VIDEO_RATIO[platform] ?? "9:16"
      return [
        {
          item,
          needCount,
          aspectRatio,
          request: this.storyboardVideoRequest(model.publicId, item, aspectRatio),
        },
      ]
    })
    if (!jobs.length) {
      throw new BadRequestException("所有分镜头的席位均已被采纳，请先取消采纳再重新生成")
    }

    // 固定一口价（积分/秒 × 分辨率档）：各 job 都带分辨率且配了对应档（时长 0/缺失按 1 秒保底）→ 免调网关按
    // 精确积分预检（× needCount，不打折口径，与终态固定价扣费同源）；任一未配置/缺档 →
    // 回落网关估价 × 席位数 × 倍率
    const fixedTotal = sumFixedVideoCredits(
      await Promise.all(
        jobs.map(job =>
          fixedVideoRequestCredits(this.usage, model.publicId, "STORYBOARD", job.request).then(
            amount => (amount ? amount.mul(job.needCount) : null)
          )
        )
      )
    )
    if (fixedTotal) await this.usage.assertExactCreditsAffordable(userId, fixedTotal)
    // 需要外部估价时，在全部素材审核通过后由Gateway提交入口统一预检。

    let totalPlaceholders = 0
    for (const { item, aspectRatio, request } of jobs) {
      const placeholderIds = await this.createStoryboardVideoSlots(item, request)

      this.logger.log(
        `[分镜头 ${item.id}] 创建 ${placeholderIds.length} 个 GENERATING 占位 videoIds=${placeholderIds.join(",")} 宽高比=${aspectRatio}`
      )

      for (const videoId of placeholderIds) {
        void this.submitStoryboardVideo(videoId, request).catch(error =>
          this.logger.error(`[分镜视频] 提交任务异常 video=${videoId}: ${(error as Error).message}`)
        )
      }

      totalPlaceholders += placeholderIds.length
    }

    this.logger.log(
      `[分镜头批量生成] 已触发 ${jobs.length}/${items.length} 条 共 ${totalPlaceholders} 个 Gateway 任务，前端请轮询 GET /customer/storyboards?ids=${ids.join(",")}`
    )

    return this.presentMedia(await this.prisma.storyboard.findMany({
      where: { id: { in: ids } },
      include: { videos: { where: { deletedAt: null }, orderBy: { id: "asc" } } },
      orderBy: [{ order: "asc" }, { id: "asc" }],
    }))
  }

  /** 标记/取消采纳分镜头席位视频 */
  async updateStoryboardVideoApproval(videoId: number, approved: boolean, userId: number) {
    await this.ensureStoryboardVideoOwnership(videoId, userId)
    const video = await this.prisma.storyboardVideo.findUnique({ where: { id: videoId } })
    if (!video) throw new NotFoundException("席位视频不存在")
    if (video.status !== "SUCCESS") {
      throw new BadRequestException("仅已生成完成的视频可采纳")
    }
    return await this.prisma.storyboardVideo.update({
      where: { id: videoId },
      data: { approved },
    })
  }

  private async submitStoryboardVideo(videoId: number, request: VideoGenerationRequest) {
    let task
    try {
      task = await this.gateway.createVideoTask(request, `storyboard-video:${videoId}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`[分镜视频] Gateway 提交失败 video=${videoId}: ${message}`)
      // 仅网关明确拒绝（400/404 参数不合法/模型下架）才终态化；
      // 429/401/403/5xx/超时视为瞬态或结果不确定，保留 GENERATING 等启动恢复按幂等键重提
      if (!(error instanceof BadRequestException)) return
      await this.prisma.storyboardVideo.updateMany({
        where: { id: videoId, status: "GENERATING", deletedAt: null },
        data: { status: "FAILED", errorMessage: "AI Gateway 分镜视频任务提交失败" },
      })
      return
    }

    await this.prisma.storyboardVideo.updateMany({
      where: { id: videoId, status: "GENERATING", gatewayTaskId: null, deletedAt: null },
      data: { gatewayTaskId: task.id },
    })
    await this.gatewayWebhook.applyVideoTask(task)
    this.logger.log(`[分镜视频] Gateway 任务已提交 video=${videoId} gatewayTask=${task.id}`)
  }

  private createStoryboardVideoSlots(
    item: GenerateStoryboardVideoItemDto,
    request: VideoGenerationRequest
  ) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM Storyboard WHERE id = ${item.id} AND deletedAt IS NULL FOR UPDATE`
      const storyboard = await tx.storyboard.findFirst({
        where: { id: item.id, deletedAt: null },
        include: { videos: { where: { deletedAt: null } } },
      })
      if (!storyboard) throw new NotFoundException("分镜头不存在")
      if (storyboard.videos.some(video => ["GENERATING", "WAITING_MODERATION"].includes(video.status))) {
        throw new BadRequestException(`分镜头 ${item.id} 的视频正在生成，请稍后再试`)
      }

      const needCount =
        CustomerService.STORYBOARD_SLOT_COUNT - storyboard.videos.filter(v => v.approved).length
      if (needCount <= 0) {
        throw new BadRequestException(`分镜头 ${item.id} 的席位均已被采纳`)
      }

      await tx.storyboard.update({
        where: { id: item.id },
        data: {
          duration: item.duration,
          prompt: item.prompt,
          firstFrameUrl: item.firstFrameUrl ?? null,
          lastFrameUrl: item.lastFrameUrl ?? null,
        },
      })
      await tx.storyboardVideo.updateMany({
        where: {
          id: { in: storyboard.videos.filter(video => !video.approved).map(video => video.id) },
        },
        data: { deletedAt: new Date() },
      })

      const placeholderIds: number[] = []
      for (let index = 0; index < needCount; index += 1) {
        const video = await tx.storyboardVideo.create({
          data: {
            storyboardId: item.id,
            status: "WAITING_MODERATION",
            generationParams: request as unknown as Prisma.InputJsonValue,
          },
        })
        placeholderIds.push(video.id)
      }
      return placeholderIds
    })
  }

  private storyboardVideoRequest(
    model: string,
    item: GenerateStoryboardVideoItemDto,
    aspectRatio: string
  ): VideoGenerationRequest {
    const mode =
      item.firstFrameUrl && item.lastFrameUrl
        ? "start_end_to_video"
        : item.firstFrameUrl || item.lastFrameUrl
          ? "image_to_video"
          : "text_to_video"
    return {
      model,
      prompt: item.prompt.trim(),
      mode,
      duration_seconds: item.duration,
      resolution: "720p",
      aspect_ratio: aspectRatio,
      ...(item.firstFrameUrl ? { first_frame: { url: item.firstFrameUrl } } : {}),
      ...(item.lastFrameUrl ? { last_frame: { url: item.lastFrameUrl } } : {}),
      generate_audio: true,
      n: 1,
      callback: true,
    }
  }

  // ==================== 素材图片 ====================

  private async presentMedia<T extends { videos?: Array<{ generationParams: unknown; generationMeta?: unknown }>; variants?: Array<{ generationMeta?: unknown }> }>(rows: T[]) {
    const ids = rows.flatMap(r => [...(r.videos ?? []).map(v => jsonObject(v.generationParams).model), ...(r.variants ?? []).map(v => jsonObject(v.generationMeta).modelPublicId)])
    const names = await modelDisplayNames(this.prisma, ids)
    return rows.map(row => ({ ...row,
      ...(row.videos ? { videos: row.videos.map(v => { const request = jsonObject(v.generationParams); return { ...v,
        modelPublicId: request.model ?? null, displayName: names.get(request.model) ?? request.model ?? null,
        mode: request.mode ?? null, ...videoMetadata(request, v.generationMeta) } }) } : {}),
      ...(row.variants ? { variants: row.variants.map(v => { const meta = jsonObject(v.generationMeta); return { ...v,
        modelPublicId: meta.modelPublicId ?? null, displayName: names.get(meta.modelPublicId) ?? meta.modelPublicId ?? null,
        resolutionTier: meta.resolutionTier ?? null, width: meta.width ?? null, height: meta.height ?? null } }) } : {}),
    }))
  }

  private static readonly MATERIAL_DEFAULT_COUNT = 5
  private static readonly MATERIAL_MAX_COUNT = 8

  /** AI 生成素材图片 prompt（默认 5 组，清空现有后重新生成） */
  /** AI 生成素材图片 prompt（默认 5 组）；已有素材图则直接返回，不覆盖 */
  async generateMaterials(projectId: number, userId: number) {
    await this.ensureProjectOwnership(projectId, userId)
    const strategy = await this.prisma.strategy.findUnique({
      where: { projectId },
      include: {
        project: {
          include: { customer: true, account: true, production: true },
        },
      },
    })
    if (!strategy) throw new NotFoundException("该项目下没有方案")
    if (!strategy.project.production) throw new NotFoundException("该项目下没有生产层")

    const productionId = strategy.project.production.id

    const existingCount = await this.prisma.materialImage.count({ where: { productionId } })
    if (existingCount === 0) {
      const plan = this.parseContentPlan(strategy.content)
      const count = CustomerService.MATERIAL_DEFAULT_COUNT

      const result = await this.google.generateText(
        MATERIAL_SYSTEM_PROMPT,
        buildMaterialPrompt(strategy.project.customer, strategy.project.account, plan, count)
      )
      if (!result) throw new NotFoundException("AI 生成素材图片失败，请稍后重试")

      const items = this.parseJsonBlock<MaterialItem[]>(result).slice(0, count)

      await this.prisma.$transaction(
        items.map((item, i) =>
          this.prisma.materialImage.create({
            data: {
              purpose: item.purpose,
              ratio: item.ratio,
              prompt: item.prompt,
              order: i,
              productionId,
            },
          })
        )
      )
    }

    await this.maybeCompleteProject(projectId)

    return this.presentMedia(await this.prisma.materialImage.findMany({
      where: { productionId },
      include: { variants: { where: { deletedAt: null } } },
      orderBy: [{ order: "asc" }, { id: "asc" }],
    }))
  }

  /** 新增一张空白素材图片（前端填写表单后再调用生成接口，校验 ≤ 8） */
  async createMaterial(projectId: number, userId: number) {
    await this.ensureProjectOwnership(projectId, userId)
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { production: true },
    })
    if (!project) throw new NotFoundException("项目不存在")
    if (!project.production) throw new NotFoundException("该项目下没有生产层")
    const productionId = project.production.id

    const count = await this.prisma.materialImage.count({ where: { productionId } })
    if (count >= CustomerService.MATERIAL_MAX_COUNT) {
      throw new BadRequestException(`素材图片已达上限 ${CustomerService.MATERIAL_MAX_COUNT} 个`)
    }

    return await this.prisma.materialImage.create({
      data: {
        purpose: "",
        ratio: "",
        prompt: "",
        order: count,
        productionId,
      },
    })
  }

  /** 删除素材图片（软删除，同时级联删除席位图片） */
  async removeMaterial(id: number, userId: number) {
    await this.ensureMaterialOwnership(id, userId)
    const material = await this.prisma.materialImage.findUnique({ where: { id } })
    if (!material) throw new NotFoundException("素材图不存在")
    const now = new Date()
    await this.prisma.$transaction([
      this.prisma.materialImageVariant.updateMany({
        where: { materialImageId: id, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.materialImage.update({ where: { id }, data: { deletedAt: now } }),
    ])
  }

  private static readonly MATERIAL_SLOT_COUNT = 4

  /**
   * 批量生成素材图片席位（Nano Banana，4 席位/素材，异步），前端可传 1 条或多条：
   * 每条会回写 prompt + 垫图（purpose/ratio 不覆盖），软删未采纳席位，
   * 按剩余席位数创建 GENERATING 占位，并 fire-and-forget 调 Nano Banana。
   * 接口立即返回所有受影响素材图的最新快照，前端轮询 `GET /customer/materials?ids=1,2,3`。
   * 所有席位已被采纳的条目会被跳过并记日志，不阻塞其他条目。
   */
  async generateMaterialVariants(items: GenerateMaterialVariantsItemDto[], userId: number) {
    const ids = items.map(i => i.id)
    await Promise.all(ids.map(id => this.ensureMaterialOwnership(id, userId)))
    this.logger.log(`[素材图批量生成] 收到 ${items.length} 条请求 ids=${ids.join(",")}`)

    const existingList = await this.prisma.materialImage.findMany({
      where: { id: { in: ids } },
      include: { variants: { where: { deletedAt: null } } },
    })
    const existingMap = new Map(existingList.map(m => [m.id, m]))
    const missing = ids.filter(id => !existingMap.has(id))
    if (missing.length) {
      throw new NotFoundException(`素材图不存在: ${missing.join(", ")}`)
    }

    const processedIds: number[] = []
    let totalPlaceholders = 0
    for (const item of items) {
      const existing = existingMap.get(item.id)!
      const approvedCount = existing.variants.filter(v => v.approved).length
      const needCount = CustomerService.MATERIAL_SLOT_COUNT - approvedCount
      if (needCount <= 0) {
        this.logger.warn(`素材图 ${item.id} 所有席位已被采纳，跳过生成`)
        continue
      }

      const material = await this.prisma.materialImage.update({
        where: { id: item.id },
        data: {
          prompt: item.prompt,
          refImageUrl: item.refImageUrl ?? null,
        },
      })

      const unapprovedIds = existing.variants.filter(v => !v.approved).map(v => v.id)
      if (unapprovedIds.length) {
        await this.prisma.materialImageVariant.updateMany({
          where: { id: { in: unapprovedIds } },
          data: { deletedAt: new Date() },
        })
      }

      const placeholders = await Promise.all(
        Array.from({ length: needCount }, () =>
          this.prisma.materialImageVariant.create({
            data: { materialImageId: item.id, status: "GENERATING", generationMeta: { modelPublicId: GoogleProvider.IMAGE_MODEL, aspectRatio: material.ratio } },
          })
        )
      )

      const refs = material.refImageUrl ? [material.refImageUrl] : []
      this.logger.log(
        `[素材图 ${item.id}] 创建 ${placeholders.length} 个 GENERATING 占位 variantIds=${placeholders
          .map(p => p.id)
          .join(",")} 宽高比=${material.ratio} 垫图=${refs.length ? "有" : "无"}`
      )

      for (const placeholder of placeholders) {
        this.runNanoBananaForMaterialVariant(placeholder.id, {
          prompt: material.prompt,
          aspectRatio: material.ratio,
          refImageUrls: refs,
        }).catch((err: Error) => {
          this.logger.error(`Nano Banana 任务异常 [variantId=${placeholder.id}]: ${err.message}`)
        })
      }

      processedIds.push(item.id)
      totalPlaceholders += placeholders.length
    }

    this.logger.log(
      `[素材图批量生成] 已触发 ${processedIds.length}/${items.length} 条 共 ${totalPlaceholders} 个 Nano Banana 任务，前端请轮询 GET /customer/materials?ids=${ids.join(",")}`
    )

    if (!processedIds.length) {
      throw new BadRequestException("所有素材图的席位均已被采纳，请先取消采纳再重新生成")
    }

    return this.presentMedia(await this.prisma.materialImage.findMany({
      where: { id: { in: ids } },
      include: { variants: { where: { deletedAt: null }, orderBy: { id: "asc" } } },
      orderBy: [{ order: "asc" }, { id: "asc" }],
    }))
  }

  /** 按 ID 批量查询素材图（含席位图片，供前端批量轮询状态） */
  async findMaterialsByIds(ids: number[], userId: number) {
    await Promise.all(ids.map(id => this.ensureMaterialOwnership(id, userId)))
    return this.presentMedia(await this.prisma.materialImage.findMany({
      where: { id: { in: ids } },
      include: { variants: { where: { deletedAt: null }, orderBy: { id: "asc" } } },
      orderBy: [{ order: "asc" }, { id: "asc" }],
    }))
  }

  /** 标记/取消采纳素材图片席位 */
  async updateMaterialVariantApproval(variantId: number, approved: boolean, userId: number) {
    await this.ensureMaterialVariantOwnership(variantId, userId)
    const variant = await this.prisma.materialImageVariant.findUnique({ where: { id: variantId } })
    if (!variant) throw new NotFoundException("席位图片不存在")
    if (variant.status !== "SUCCESS") {
      throw new BadRequestException("仅已生成完成的图片可采纳")
    }
    return await this.prisma.materialImageVariant.update({
      where: { id: variantId },
      data: { approved },
    })
  }

  /** 后台任务：调 Nano Banana → 上传 OSS → 回写 DB（墙钟 10 分钟超时） */
  private async runNanoBananaForMaterialVariant(
    variantId: number,
    params: {
      prompt: string
      aspectRatio: string
      refImageUrls: string[]
    }
  ) {
    const tag = `[NanoBanana variantId=${variantId}]`
    const markFailed = async (reason: string) => {
      this.logger.error(`${tag} 失败: ${reason}`)
      await this.prisma.materialImageVariant.update({
        where: { id: variantId },
        data: { status: "FAILED", errorMessage: reason },
      })
    }

    const startedAt = Date.now()
    this.logger.log(
      `${tag} 开始 | aspectRatio=${params.aspectRatio} refImages=${params.refImageUrls.length} ` +
        `promptHead="${params.prompt.slice(0, 60)}..."`
    )

    const job = async () => {
      this.logger.log(`${tag} 步骤 1/2 调用 Nano Banana 生成图片`)
      const image = await this.google.generateImage(params.prompt, {
        aspectRatio: params.aspectRatio,
        refImageUrls: params.refImageUrls,
      })
      if (!image) {
        await markFailed("Nano Banana 生成失败")
        return
      }
      this.logger.log(
        `${tag} 图片生成完成 mime=${image.mimeType} size=${(image.data.length / 1024).toFixed(1)}KB`
      )

      const ext = image.mimeType.includes("jpeg") || image.mimeType.includes("jpg") ? "jpg" : "png"
      const key = `material-variant/${variantId}/${Date.now()}.${ext}`
      this.logger.log(`${tag} 步骤 2/2 上传 OSS key=${key}`)
      const labeled = await retryDelivery(() => labelImage(image.data, `material-variant:${variantId}`))
      const url = await this.oss.uploadBuffer(labeled.buffer, key, labeled.mime)

      await this.prisma.materialImageVariant.update({
        where: { id: variantId },
        data: { status: "SUCCESS", url, errorMessage: null, generationMeta: { modelPublicId: GoogleProvider.IMAGE_MODEL, aspectRatio: params.aspectRatio,
          width: labeled.width, height: labeled.height } },
      })
      this.logger.log(
        `${tag} 成功 ✓ url=${url} 总耗时=${((Date.now() - startedAt) / 1000).toFixed(1)}s`
      )
    }

    try {
      await this.withTimeout(
        job(),
        CustomerService.ASYNC_TASK_TIMEOUT_MS,
        `Nano Banana 任务超时（${CustomerService.ASYNC_TASK_TIMEOUT_MS / 60_000} 分钟）`
      )
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      await markFailed(message)
    }
  }

  /** 通用墙钟超时包装：任务未在 ms 内完成则 reject（不中断内部 IO，但保证外层能回写 FAILED） */
  private withTimeout<T>(task: Promise<T>, ms: number, reason: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(reason)), ms)
    })
    return Promise.race([task, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    }) as Promise<T>
  }

  /** 合成数字人视频：创建口播稿 + 提交百度合成任务 */
  async synthesizeVideo(dto: SynthesizeVideoDto, userId: number) {
    const { productionId, content, avatarId, voiceId, speed, volume, pitch } = dto

    // 只要校验 productionId 归属；avatar/voice 归属在同一 customer 下默认也属同一 user。
    // 但保险起见，仍通过独立 helper 校验，避免跨 customer 借用他人形象/音色。
    await Promise.all([
      this.ensureProductionOwnership(productionId, userId),
      this.ensureAvatarOwnership(avatarId, userId),
      this.ensureVoiceOwnership(voiceId, userId),
    ])

    const [production, avatar, voice] = await Promise.all([
      this.prisma.production.findUnique({ where: { id: productionId } }),
      this.prisma.avatar.findUnique({ where: { id: avatarId } }),
      this.prisma.voice.findUnique({ where: { id: voiceId } }),
    ])
    if (!production) throw new NotFoundException("生产层不存在")
    if (!avatar) throw new NotFoundException("形象不存在")
    if (!voice) throw new NotFoundException("音色不存在")
    if (avatar.status !== "SUCCESS" || !avatar.figureId) {
      throw new BadRequestException("数字人尚未训练完成，无法合成视频")
    }
    if (voice.status !== "SUCCESS" || !voice.perId) {
      throw new BadRequestException("音色尚未克隆完成，无法合成视频")
    }

    // 公共资源下架校验：若镜像 isActive=false（或整个从百度消失），拒绝合成
    let avatarQueryOptions: { systemFigure?: boolean; item?: string } = {}
    if (avatar.kind === "PUBLIC") {
      const pub = await this.prisma.publicAvatar.findUnique({
        where: { figureId: avatar.figureId },
        select: { item: true, isActive: true },
      })
      if (!pub || !pub.isActive) {
        throw new BadRequestException("所选公共形象已下架，请更换")
      }
      avatarQueryOptions = { systemFigure: true, item: pub.item }
    }
    if (voice.kind === "PUBLIC") {
      const pub = await this.prisma.publicVoice.findUnique({ where: { perId: voice.perId } })
      if (!pub || !pub.isActive) {
        throw new BadRequestException("所选公共音色已下架，请更换")
      }
    }

    // 视频分辨率沿用数字人底板原始分辨率（曦灵要求不能超过底板宽高）
    const avatarInfo = await this.baiduXiling.queryAvatar(avatar.figureId, avatarQueryOptions)

    const taskId = await this.baiduXiling.createVideoTask({
      figureId: avatar.figureId,
      perId: voice.perId,
      text: content,
      width: avatarInfo.resolutionWidth,
      height: avatarInfo.resolutionHeight,
      callbackUrl: `${this.config.get<string>("API_BASE_URL")}/api/customer/webhook/video`,
      speed,
      volume,
      pitch,
    })

    return await this.prisma.script.create({
      data: {
        content,
        avatarId,
        voiceId,
        productionId,
        videoTaskId: taskId,
        videoMeta: { modelPublicId: "baidu-xiling", engineName: "百度曦灵", requestedWidth: avatarInfo.resolutionWidth, requestedHeight: avatarInfo.resolutionHeight },
        videoStatus: "GENERATING",
        speed,
        volume,
        pitch,
      },
    })
  }

  async handleVideoWebhook(body: VideoWebhookPayload) {
    const { taskId, status, videoUrl, duration, failedMessage } = body.data
    this.logger.log(
      `[VideoWebhook] taskId=${taskId} raw=${status} duration=${duration ?? "-"} failedMessage=${failedMessage ?? "-"}`
    )
    const script = await this.prisma.script.findUnique({ where: { videoTaskId: taskId } })
    if (!script) {
      this.logger.warn(`Video webhook: 未找到 taskId=${taskId}`)
      return
    }
    await this.applyVideoStatus(taskId, status, videoUrl, duration, failedMessage)
  }

  // ==================== 标签 ====================

  async findTags(category: TagCategory) {
    return await this.prisma.tag.findMany({
      where: { category },
      orderBy: { createdAt: "desc" },
    })
  }

  /** 解析方案 content 中的 JSON */
  private parseContentPlan(content: string): ContentPlan {
    return this.parseJsonBlock<ContentPlan>(content)
  }

  /** 解析 AI 返回的 JSON（兼容 markdown 代码块包裹） */
  private parseJsonBlock<T>(content: string): T {
    const cleaned = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "")
    try {
      return JSON.parse(cleaned) as T
    } catch {
      throw new NotFoundException("AI 返回内容格式异常，无法解析")
    }
  }

  private async ensureTags(category: TagCategory, names: string[]) {
    await Promise.all(
      names.map(name =>
        this.prisma.tag.upsert({
          where: { name_category: { name, category } },
          create: { name, category },
          update: {},
        })
      )
    )
  }
}
