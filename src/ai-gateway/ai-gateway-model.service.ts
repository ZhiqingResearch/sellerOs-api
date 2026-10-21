import { BadGatewayException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { AiModelExecMode, AiModelModality, Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { safeMultiplier } from "../common/price-multiplier.util"
import { CREDIT_PER_CNY } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { AiGatewayProvider } from "./ai-gateway.provider"
import { AiGatewayVideoQuoteDto, QueryAiGatewayModelsDto } from "./dto/ai-gateway-model.dto"

function asObject(value: Prisma.JsonValue | null | undefined): Prisma.JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null
}

// 目录刷新间隔：距该分类最后一次成功同步（syncedAt）超过 30 分钟才会在读取列表时再次刷新
const MODEL_REFRESH_INTERVAL_MS = 30 * 60 * 1000

@Injectable()
export class AiGatewayModelService {
  private readonly logger = new Logger(AiGatewayModelService.name)
  /** 进行中的分类刷新（单飞），键 = `${modality}:${category}` */
  private readonly refreshingCategories = new Set<string>()
  /** 每分类最近一次刷新尝试时间（键同上）：网关故障时 syncedAt 不会更新，用它兜底防止每次列表请求都打网关 */
  private readonly lastAttemptAt = new Map<string, number>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayProvider,
    private readonly usage: UsageService
  ) {}

  async findAll(query: Partial<QueryAiGatewayModelsDto>) {
    // 读时后台刷新（fire-and-forget + 按 syncedAt 节流）：本次响应仍返回本地快照，网关最新能力下一次读取生效。
    // 视频/图片按模态分派；TEXT（拆图分析模型，chat.completions）不参与读时刷新，仍由 sync-ai-split-models.ts 手动同步
    if (query.modality === AiModelModality.VIDEO || query.modality === AiModelModality.IMAGE) {
      void this.maybeRefreshModels(query.modality, query.category)
    }

    const models = await this.prisma.aiGatewayModel.findMany({
      where: {
        modality: query.modality,
        category: query.category,
        enabled: true,
        gatewayActive: true,
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: {
        publicId: true,
        displayName: true,
        modality: true,
        execMode: true,
        fixedCredits: true,
        gatewayConfig: true,
      },
    })

    // 视频固定一口价（积分/秒，按分辨率分档）：随目录下发供前端展示「X 积分/秒」，
    // 未配置的模型为 null（前端可回落展示按量报价）。通配行（mode=''）走 fixedCreditsByResolution；
    // 按模式分价的行（如 reference_to_video / video_to_video）走 fixedCreditsByMode 二级映射
    const fixedByModel = new Map<string, Record<string, string>>()
    const fixedByModelMode = new Map<string, Record<string, Record<string, string>>>()
    if (query.modality === AiModelModality.VIDEO && models.length) {
      const priceRows = await this.prisma.aiGatewayVideoFixedPrice.findMany({
        where: {
          publicId: { in: models.map(model => model.publicId) },
          category: query.category,
        },
        select: { publicId: true, mode: true, resolution: true, creditsPerSec: true },
      })
      for (const row of priceRows) {
        const resolution = row.resolution?.trim().toLowerCase()
        if (!resolution || row.creditsPerSec == null || !new Decimal(row.creditsPerSec).gt(0))
          continue
        const credits = row.creditsPerSec.toString()
        const mode = row.mode?.trim().toLowerCase() ?? ""
        if (!mode) {
          const perModel = fixedByModel.get(row.publicId) ?? {}
          perModel[resolution] = credits
          fixedByModel.set(row.publicId, perModel)
        } else {
          const perMode = fixedByModelMode.get(row.publicId) ?? {}
          const perModel = perMode[mode] ?? {}
          perModel[resolution] = credits
          perMode[mode] = perModel
          fixedByModelMode.set(row.publicId, perMode)
        }
      }
    }

    return {
      items: models.map(({ gatewayConfig, ...model }) => {
        const config = asObject(gatewayConfig)
        const detail = asObject(config?.detail)
        const schema = asObject(config?.requestSchema)
        return {
          ...model,
          displayName:
            query.category === "CHETAIDOU_MULTIMODAL"
              ? ((
                  {
                    "ZQ-Multimodal-Gemini-3.8-Flash": "ZQ-ZL-1",
                    "ZQ-Think-Lite": "ZQ-ZL-2",
                  } as Record<string, string>
                )[model.publicId] ?? model.displayName)
              : model.displayName,
          ...(query.category === "CHETAIDOU_IMAGE"
            ? { recommended: model.publicId === "ZQ-Image-1" }
            : {}),
          facts: detail?.facts ?? {},
          requestSchema: schema?.request_schema ?? {},
          ...(query.modality === AiModelModality.VIDEO
            ? {
                fixedCreditsByResolution: fixedByModel.get(model.publicId) ?? null,
                fixedCreditsByMode: fixedByModelMode.get(model.publicId) ?? null,
              }
            : {}),
        }
      }),
    }
  }

  async quote(dto: AiGatewayVideoQuoteDto) {
    const model = await this.prisma.aiGatewayModel.findFirst({
      where: {
        publicId: dto.publicId,
        category: dto.category,
        modality: AiModelModality.VIDEO,
        enabled: true,
        gatewayActive: true,
      },
      select: { publicId: true, priceMultiplier: true },
    })
    if (!model) throw new NotFoundException("模型不存在或未启用")

    // 单位报价优先使用一口价；成本仅用于预估，不参与实际扣费。
    const fixedTier = await this.usage.resolveFixedVideoTier(
      model.publicId,
      dto.category,
      dto.params.resolution,
      dto.params.mode
    )
    if (fixedTier) {
      const credits = fixedTier.creditsPerSec
      const amountCny = credits.div(CREDIT_PER_CNY).toString()
      const modeLabel = dto.params.mode ? `${dto.params.mode} · ` : ""
      const variant = {
        parameters: {
          ...(dto.params.resolution ? { resolution: dto.params.resolution } : {}),
          ...(dto.params.mode ? { mode: dto.params.mode } : {}),
        },
        estimated_amount: amountCny,
        minimum_amount: amountCny,
        maximum_amount: amountCny,
        exact: true,
        route_dependent: false,
        assumptions: [
          fixedTier.flat
            ? `固定一口价：${credits.toString()} 积分/次`
            : `固定一口价：${modeLabel}${credits.toString()} 积分/秒`,
        ],
        estimated_credits: credits.toString(),
        minimum_credits: credits.toString(),
        maximum_credits: credits.toString(),
        pricingMode: "fixed" as const,
        billingUnit: fixedTier.flat ? ("REQUEST" as const) : ("SECOND" as const),
      }
      return {
        object: "pricing.estimate" as const,
        model: model.publicId,
        operation: "videos.generations" as const,
        currency: "CNY" as const,
        variants: [variant],
        pricing_version: "fixed-unit-credits",
        expires_at: Math.floor(Date.now() / 1000),
      }
    }

    const rows = await this.prisma.aiGatewayVideoFixedPrice.findMany({
      where: { publicId: model.publicId, category: dto.category },
      select: {
        mode: true,
        resolution: true,
        costMinCny: true,
        costMaxCny: true,
        costPerRequest: true,
      },
    })
    const mode = dto.params.mode?.trim().toLowerCase() ?? ""
    const costs = new Map<string, (typeof rows)[number]>()
    // 精确 mode 优先，通配行仅填补未配置的档位。
    for (const row of [
      ...rows.filter(row => row.mode.trim().toLowerCase() === mode),
      ...rows.filter(row => !row.mode.trim()),
    ]) {
      const resolution = row.resolution.trim().toLowerCase()
      if (!resolution || costs.has(resolution) || row.costMinCny == null || row.costMaxCny == null)
        continue
      const min = new Decimal(row.costMinCny),
        max = new Decimal(row.costMaxCny)
      if (!min.isFinite() || !max.isFinite() || min.lt(0) || max.lt(min)) {
        throw new BadGatewayException("视频预估成本配置无效")
      }
      costs.set(resolution, row)
    }
    const resolution = dto.params.resolution?.trim().toLowerCase()
    const resolutions = resolution
      ? [resolution]
      : costs.has("adaptive")
        ? ["adaptive"]
        : [...costs.keys()].filter(key => key !== "flat").sort()
    if (!resolutions.length) resolutions.push("flat")
    const multiplier = safeMultiplier(model.priceMultiplier)
    return {
      object: "pricing.estimate" as const,
      model: model.publicId,
      operation: "videos.generations" as const,
      currency: "CNY" as const,
      pricing_version: "local-video-unit-costs",
      expires_at: Math.floor(Date.now() / 1000),
      variants: resolutions.map(key => {
        const row = costs.get(key) ?? (key !== "adaptive" ? costs.get("flat") : undefined)
        const flat =
          row?.resolution.trim().toLowerCase() === "flat" ||
          row?.resolution.trim().toLowerCase() === "adaptive"
        const perRequest = !!row?.costPerRequest || flat
        const min = row ? new Decimal(row.costMinCny!).mul(multiplier).toString() : null
        const max = row ? new Decimal(row.costMaxCny!).mul(multiplier).toString() : null
        const estimated = min === max ? min : null
        return {
          parameters: {
            ...(key !== "flat" && key !== "adaptive" ? { resolution: key } : {}),
            ...(dto.params.mode ? { mode: dto.params.mode } : {}),
          },
          estimated_amount: estimated,
          minimum_amount: min,
          maximum_amount: max,
          estimated_credits: this.toCredits(estimated, perRequest),
          minimum_credits: this.toCredits(min, perRequest),
          maximum_credits: this.toCredits(max, perRequest),
          exact: false,
          route_dependent: false,
          pricingMode: "metered" as const,
          billingUnit: row ? (perRequest ? ("REQUEST" as const) : ("SECOND" as const)) : null,
          assumptions: [
            row
              ? `本地成本单位预估（积分/${perRequest ? "次" : "秒"}），实际按网关账单结算；区间使用最低/最高积分展示`
              : "暂无法预估：缺少成本配置",
          ],
        }
      }),
    }
  }

  private toCredits(amount: string | null, perRequest: boolean): string | null {
    if (amount === null) return null
    try {
      const value = new Decimal(amount)
      if (!value.isFinite() || value.isNegative()) throw new Error()
      const credits = value.mul(CREDIT_PER_CNY)
      // 秒单价保留精度，由前端乘时长后再取整；按次报价直接取整。
      return (perRequest ? credits.ceil() : credits).toString()
    } catch {
      throw new BadGatewayException("AI Gateway 返回了无效的预估金额")
    }
  }

  /**
   * 读时触发的分类目录后台刷新（按 syncedAt 节流 + 单飞，失败静默只记日志），覆盖 VIDEO / IMAGE 两个模态。
   * 以「模态+分类」最近一次成功同步时间（行上的 syncedAt 最大值）判断：30 分钟内刷新过就不再打网关。
   * 逻辑与手动同步脚本一致：只 update 已有行、不 create（新模型上架仍需人工建行评审）；
   * 网关 404（已下架）置 gatewayActive=false，列表据此隐藏。
   */
  async maybeRefreshModels(modality: AiModelModality, category?: string): Promise<void> {
    if (!this.gateway.isConfigured()) return
    const throttleKey = `${modality}:${category}`
    if (this.refreshingCategories.has(throttleKey)) return
    if (Date.now() - (this.lastAttemptAt.get(throttleKey) ?? 0) < MODEL_REFRESH_INTERVAL_MS) return

    try {
      const last = await this.prisma.aiGatewayModel.findFirst({
        where: { modality, category },
        orderBy: { syncedAt: "desc" },
        select: { syncedAt: true },
      })
      if (last?.syncedAt && Date.now() - last.syncedAt.getTime() < MODEL_REFRESH_INTERVAL_MS) {
        return
      }

      this.refreshingCategories.add(throttleKey)
      this.lastAttemptAt.set(throttleKey, Date.now())

      const rows = await this.prisma.aiGatewayModel.findMany({
        where: { modality, category },
        select: { publicId: true, category: true },
      })
      const operation =
        modality === AiModelModality.VIDEO ? "videos.generations" : "images.generations"
      // 目录行的 modality 枚举值（"video"/"image"）与网关 detail 的模态字符串同值，直接比对
      const expectedModality = modality === AiModelModality.VIDEO ? "video" : "image"
      let synced = 0
      for (const row of rows) {
        try {
          const snapshot = await this.gateway.fetchModelSnapshot(row.publicId, operation)
          if (!snapshot) {
            await this.prisma.aiGatewayModel.update({
              where: { publicId_category: { publicId: row.publicId, category: row.category } },
              data: { gatewayActive: false, syncedAt: new Date() },
            })
            this.logger.warn(
              `[AI Gateway] 模型已在网关下架，本地置为不可用 publicId=${row.publicId}`
            )
            continue
          }
          if (snapshot.detail.modality !== expectedModality) {
            this.logger.warn(
              `[AI Gateway] 网关返回的不是${modality === AiModelModality.VIDEO ? "视频" : "图片"}模型，跳过 publicId=${row.publicId}`
            )
            continue
          }
          await this.prisma.aiGatewayModel.update({
            where: { publicId_category: { publicId: row.publicId, category: row.category } },
            data: {
              displayName: snapshot.detail.display_name,
              execMode:
                snapshot.detail.exec_mode === "sync" ? AiModelExecMode.SYNC : AiModelExecMode.ASYNC,
              gatewayConfig: {
                detail: snapshot.detail,
                requestSchema: snapshot.requestSchema,
              } as unknown as Prisma.InputJsonValue,
              gatewayActive: true,
              syncedAt: new Date(),
            },
          })
          synced++
        } catch (error) {
          this.logger.warn(
            `[AI Gateway] 模型目录刷新跳过 publicId=${row.publicId}: ${(error as Error).message}`
          )
        }
      }
      if (rows.length) {
        this.logger.log(
          `[AI Gateway] 模型目录后台刷新完成 modality=${modality} category=${category} ${synced}/${rows.length} 行`
        )
      }
    } catch (error) {
      this.logger.warn(
        `[AI Gateway] 模型目录后台刷新失败 modality=${modality} category=${category}：${(error as Error).message}`
      )
    } finally {
      this.refreshingCategories.delete(throttleKey)
    }
  }
}
