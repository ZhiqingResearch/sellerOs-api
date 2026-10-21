import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import {
  CreditBucket,
  InvokeType,
  OverLimitPolicy,
  Prisma,
  TeamQuotaMode,
  TeamStatus,
  UsageType,
} from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { randomUUID } from "crypto"
import {
  mergeUserPermissions,
  mergeUserRoles,
  userRolesSelect,
} from "../auth/role-permissions.util"
import { safeMultiplier } from "../common/price-multiplier.util"
import { beijingMonthStart } from "../common/utils/datetime"
import { ConsumeBreakdownItem, ConsumeResult, CreditService } from "../membership/credit.service"
import {
  CREDIT_PER_CNY,
  GIFT_LAYER_BUCKETS,
  resolveLevel,
} from "../membership/membership.constants"
import { PricingService } from "../pricing/pricing.service"
import { PrismaService } from "../prisma/prisma.service"
import { TeamModelConfigService } from "../team/team-model-config.service"
import { TeamQuotaService } from "../team/team-quota.service"
import { quotaMonthOf, TEAM_MODEL_MODULES, TeamMemberStatus } from "../team/team.constants"
import { ChargeMcpDto } from "./dto/charge-mcp.dto"
import { ChargeTokensDto } from "./dto/charge-tokens.dto"
import { QueryUsageLogsDto } from "./dto/query-usage-logs.dto"
import { QueryUsageStatsDto, StatsPeriod } from "./dto/query-usage-stats.dto"
import {
  UsageStatsByUserItemDto,
  UsageStatsSourceItemDto,
  UsageStatsSummaryDto,
} from "./dto/usage-stats.dto"
import { FeatureRegistryService } from "./feature-registry.service"
import {
  FIXED_MODULE_CREDITS,
  getFixedModuleCredits,
  listingGenerationChargeId,
  type FixedModuleSource,
} from "./fixed-module-credits"
import { getUsageSourceOptions, RegisteredFeature } from "./usage-source-labels"

const MILLION = new Decimal(1_000_000)
const ZERO = new Decimal(0)

export interface ChargeResult {
  costCny: Decimal // 人民币成本（审计 / 对账）
  creditsCharged: Decimal // 本次实扣积分（含折扣）
  balance: Decimal // 扣后可消费积分余额
  breakdown: ConsumeBreakdownItem[] // 跨桶扣减明细
}

export interface ChargeVideoParams {
  mode: string
  model: string
  durationSec: number
  resolution?: string | null
  aspectRatio?: string | null
  projectId?: number
  taskId?: number
  modelId?: string
  source?: string
  meta?: Record<string, unknown>
}

export interface ChargeExactCreditsParams {
  credits: Decimal | number | string
  costCny: Decimal | number | string
  source: string
  meta?: Record<string, unknown>
  allowOverdraft?: boolean
}

export interface ChargeModelParams {
  source: string // 功能模块 key（FeatureModule.source，注册表校验，未登记 400）
  model: string // 模型标识（底座/业务侧模型 id，落 UsageLog.meta.model → 用量分析模型维度）
  meta?: Record<string, unknown> // 附加元数据（写双方流水 meta）
  requestId?: string // 幂等键（重复提交返回首次结果不重复扣；对外接口必填）
  allowOverdraft?: boolean // 仅后端内部可用（HTTP 端点不暴露）
  /** 积分折算系数（轨道 B 生图,818d775 引入）:1 = 基准口径。仅放大扣减
   *  积分,UsageLog.costCny 仍记真实金额供对账;HTTP 端点不暴露。 */
  creditMultiplier?: Decimal | string | number
  /** 精确积分扣费（图片固定一口价）:直接按该积分值扣减,跳过折扣与
   *  creditMultiplier 换算（一口价即最终价）。与 creditMultiplier 互斥;
   *  UsageLog.costCny 记调用方传入的名义售价（积分÷CREDIT_PER_CNY）。
   *  HTTP 端点不暴露。 */
  exactCredits?: Decimal | string | number
  invokeType?: InvokeType // 调用方式：API=开放平台服务间扣费（/api/open/* 入口传入）；缺省 PLATFORM
}

export interface ChargeModelResult extends ChargeResult {
  source: string
  sourceLabel: string
  module: string | null
  moduleLabel: string | null
  model: string
  requestId: string | null
  duplicate: boolean // true=命中幂等键，本次未重复扣（金额为首次扣费结果）
}

interface VideoChargeQuote {
  cost: Decimal
  unitPrice: Decimal
  billableDurationSec: number
  requestedDurationSec: number
  effectiveResolution: string | null
  pricingRule: string
}

export interface VideoCreditsPerSecondPreview {
  default: number
  min: number
  max: number
}

// 各模型「成本价」（元/秒），对用户计费一律在此基础上乘 VIDEO_MARKUP 加价。
// ① 可灵 O3（video-lite × 常规模式）：无分辨率档，固定 元/秒
//    注意 video-lite × 全能参考是官方 Veo 3.1 Fast referenceImages，按 Veo 价（见 resolveVideoUnitPrice）
const VIDEO_LITE_COST_CNY = new Decimal("0.75")

// ② Veo 3.1 Fast（video-flash，TokenLab 中转）：官方美元/秒 × 汇率，再统一 ×VIDEO_MARKUP（与 Grok 同套口径）。
// 单价取 TokenLab veo3.1-fast「官方售价」逐档（来源 tokenlab.sh/zh/models/veo-3 定价矩阵，
// image/reference/start-end 同价）：720p $0.10/s、1080p $0.12/s、4k $0.30/s。
// 注：此表由 video-flash 两种模式共用——NORMAL 是 Veo 3.1 Fast（仅 720p/1080p），
// REFERENCE 是 Gemini Omni Flash（resolveVideoUnitPrice 里 video-flash 统一走 veoFastUnitPrice），
// 后者能力仍含 4k，故 4k 档必须保留（删了会让启动期 assertVideoPricingCovered 漏配抛错）。
const VEO_FAST_USD_PER_SEC: Record<string, string> = {
  "720p": "0.10",
  "1080p": "0.12",
  "4k": "0.30",
}
const VEO_FX_CNY_PER_USD = new Decimal("7") // 美元→人民币汇率

// ③ Seedance 2.0（video-pro）：元/秒，按分辨率档（清晰度越高越贵）
const VIDEO_PRO_COST_CNY: Record<string, string> = {
  "480p": "0.67",
  "720p": "1.20",
  "720p-SR": "1.70",
  "1080p": "2.40",
  "1080p-SR": "3.40",
  "1440p-SR": "4.60",
}

// ③-2 Seedance 2.0 Mini（video-mini，Atlas 链路）：按 Atlas 当前 -30% 折扣价计成本。
// 标准价：480p $0.056/s；720p 按 24fps token 公式约 $0.121/s。
// 折扣价：$0.056 × 0.7 = $0.0392/s；$0.121 × 0.7 = $0.0847/s。
// SR 档按官方文档标注的生成源计价：720p-SR 源为 480p，1080p/1440p-SR 源为 720p。
const SEEDANCE_MINI_USD_PER_SEC: Record<string, string> = {
  "480p": "0.0392",
  "720p": "0.0847",
  "720p-SR": "0.0392",
  "1080p-SR": "0.0847",
  "1440p-SR": "0.0847",
}

// ④ Gemini Omni Flash 参考生视频（video-flash-reference）：官方「每次生成」固定价（美元/次），
// 按分辨率分档、与时长无关（720p/1080p 同价）。成本价 = 美元/次 × 汇率，再统一 × VIDEO_MARKUP。
// 来源：atlascloud.ai/models/google/gemini-omni-flash/reference-to-video-developer（fixed per generation）
const VIDEO_FLASH_REF_USD_PER_GEN: Record<string, string> = {
  "720p": "1.60",
  "1080p": "1.60",
  "4k": "2.40",
}

// ⑤ Grok Imagine（video-imagine / video-imagine-reference，TokenLab 链路）：官方美元/秒，按分辨率分档。
// 来源：GET /v1/models/grok-imagine-video（480p $0.05/s、720p $0.07/s）。
// 视频转视频（video-imagine-reference）无时长/分辨率参数（xAI edit 仅收 prompt + video_url）：
// 成功后按上游报告的实际出片时长结算（见 setSuccessResultAndCharge），未报时长才按
// 「自动时长固定秒数」兜底；分辨率按 720p 档兜底；
// 官方的图/视频输入附加费（$0.002/图、$0.01/s）不单独计，由统一加价倍数覆盖。
const GROK_IMAGINE_USD_PER_SEC: Record<string, string> = {
  "480p": "0.05",
  "720p": "0.07",
}

// ⑤-2 Grok Imagine 1.5 preview（video-imagine-1.5-preview）：官方美元/秒约为 1.0 的两倍。
// 来源：GET /v1/models/grok-imagine-video-1.5-preview（480p $0.08/s、720p $0.14/s，图输入 $0.01/张同样由加价覆盖）
const GROK_IMAGINE_15_USD_PER_SEC: Record<string, string> = {
  "480p": "0.08",
  "720p": "0.14",
}

// ⑥ 可灵 Kling V3.0 Turbo（video-turbo，Atlas 链路）：官方原价美元/秒 × 汇率，再统一 × VIDEO_MARKUP。
// 取官方 standard 原价 $0.112/s（非 Atlas 折后实付 $0.095/s）；720p/1080p 同价（按秒计费，与分辨率无关）。
const VIDEO_TURBO_USD_PER_SEC = new Decimal("0.112")

// ⑦ 可灵 Kling O3 标准版视频编辑（video-edit，Atlas 链路）：官方原价美元/秒 × 汇率，再统一 × VIDEO_MARKUP。
// 取官方 standard 原价 $0.126/s（非 Atlas 折后实付 $0.107/s）；无分辨率档，按秒计费。
// 该模型无时长参数（出片跟随源视频 ≤10s）：durationSec 落 0 → 按「自动时长固定秒数」兜底结算。
const VIDEO_EDIT_USD_PER_SEC = new Decimal("0.126")

// ⑧ 可灵 Kling 3.0 Motion Control 动作复刻（kling-motion，TokenLab 链路）：官方美元/秒，按分辨率分档。
// 来源：GET /v1/models/kling-3.0-motion-control（1280x720 $0.13235294/s、1920x1080 $0.17647059/s）。
// 时长跟随动作视频，TokenLab 回报真实时长时按真实时长结算；未报则按自动时长固定秒数兜底。
const KLING_MOTION_USD_PER_SEC: Record<string, string> = {
  "720p": "0.13235294",
  "1080p": "0.17647059",
}

// ⑨ 豆包 Seedance 2.0 Fast（video-ultra / video-ultra-reference，Atlas 链路）：
// Atlas 当前实付优惠价 $0.072/秒（常规图生 / 参考生、480p / 720p 同价）。
// 成本价 = 美元/秒 × 汇率，再统一 × VIDEO_MARKUP；Atlas 调价时同步更新此常量。
const ATLAS_SEEDANCE_FAST_USD_PER_SEC = new Decimal("0.072")

// ⑩ 速创 API（google_omni / gork_imagine）：文档按量计费 0.1 元/秒（人民币）。
// 统一按秒计费；google_omni 的 size / gork_imagine 的 aspect_ratio 不影响单价。
const SUCHUANG_VIDEO_COST_CNY_PER_SEC = new Decimal("0.1")

// ⑪ Seedance 2.5（Atlas：image-to-video / reference-to-video）：定价表统一 $0.134/秒，
// 480p/720p、常规/全能参考同价。视频编辑由调用方传入源视频时长作为结算时长。
const SEEDANCE_25_USD_PER_SEC = new Decimal("0.134")

// 统一加价倍数：用户实付 = 成本价 × 该倍数
const VIDEO_MARKUP = new Decimal("2")

// 自动时长（durationSec=-1，如 Seedance 自动档）无法预知实际出片长度，按固定秒数计费
const VIDEO_AUTO_DURATION_BILL_SEC = 5

// 远程 MySQL 在积分批次加锁与写双流水时可能超过 Prisma 默认的 5 秒事务时限。
const USAGE_TRANSACTION_MAX_WAIT_MS = 10_000
const USAGE_TRANSACTION_TIMEOUT_MS = 20_000

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly credit: CreditService,
    private readonly teamQuota: TeamQuotaService,
    private readonly features: FeatureRegistryService,
    private readonly teamModelConfig: TeamModelConfigService
  ) {}

  /** 扣除 token 费用并记录流水 */
  async chargeTokens(
    userId: number,
    dto: ChargeTokensDto,
    options: { invokeType?: InvokeType } = {}
  ): Promise<ChargeResult> {
    if (
      dto.source &&
      dto.source !== "flow.workbench" &&
      Object.hasOwn(FIXED_MODULE_CREDITS, dto.source)
    ) {
      return {
        costCny: ZERO,
        creditsCharged: ZERO,
        balance: await this.credit.getConsumableBalanceRouted(userId),
        breakdown: [],
      }
    }

    const promptTokens = dto.promptTokens
    const completionTokens = dto.completionTokens
    const thinkingTokens = dto.thinkingTokens ?? 0
    const outputTokens = completionTokens + thinkingTokens

    // 档位由 promptTokens 决定，输入输出共用同一档单价
    const { inputPriceCny, outputPriceCny } = await this.pricing.getTokenPriceTier(promptTokens)

    const inputCost = new Decimal(promptTokens).div(MILLION).mul(inputPriceCny)
    const outputCost = new Decimal(outputTokens).div(MILLION).mul(outputPriceCny)
    const cost = inputCost.plus(outputCost)

    // 模型落账（用量分析「按模型」分组）：调用方显式传 > meta.model（老调用兼容）> 团队成员按功能模块配置记默认模型
    const model = await this.resolveModelForLog(userId, dto.source, dto.model, dto.meta)
    const meta = this.withUsageChargeMeta(dto.meta, "token")
    if (model) meta.model = model

    const result = await this.deduct(userId, cost, {
      type: UsageType.TOKEN,
      promptTokens,
      completionTokens,
      thinkingTokens,
      mcpCalls: null,
      inputCost,
      outputCost,
      source: dto.source,
      invokeType: options.invokeType,
      meta: Object.keys(meta).length ? meta : undefined,
      requestParams: dto.requestParams,
    })

    this.logger.log(
      `chargeTokens user=${userId} prompt=${promptTokens} output=${outputTokens} costCny=${cost.toString()} credits=${result.creditsCharged.toString()} balance=${result.balance.toString()} model=${model ?? "-"}`
    )

    return result
  }

  /**
   * 解析应记录到用量日志的模型：调用方显式传 > meta.model（老调用兼容）> 团队成员回落默认模型——
   * 挂菜单的功能按「团队模型配置」该模块默认（FeatureModule.module ↔ TEAM_MODEL_MODULES 同 key 空间，
   * 模块未配置时 resolveModuleModels 内部回落团队全局默认）；未归菜单的通用 source（llm.generic/
   * ai.chat 等）回落团队全局文本默认（token 计费必然是文本模型，按构造成立）。个人用户/解析失败不记录，绝不影响扣费主链路。
   */
  private async resolveModelForLog(
    userId: number,
    source: string | undefined,
    explicit: string | undefined,
    meta: Record<string, unknown> | undefined
  ): Promise<string | null> {
    const fromCaller = explicit?.trim() || (typeof meta?.model === "string" ? meta.model : "")
    if (fromCaller) return fromCaller
    if (!source) return null
    try {
      const membership = await this.prisma.teamMember.findFirst({
        where: {
          userId,
          status: TeamMemberStatus.ACTIVE,
          team: { status: TeamStatus.ACTIVE },
        },
        select: { teamId: true },
      })
      if (!membership) return null
      const moduleKey = this.features.get(source)?.module
      const def = moduleKey ? TEAM_MODEL_MODULES.find(d => d.moduleKey === moduleKey) : undefined
      if (def) {
        const resolution = await this.teamModelConfig.resolveModuleModels(
          membership.teamId,
          def.moduleKey,
          def.kind.toLowerCase() as "text" | "image" | "video"
        )
        return resolution.defaultModel
      }
      // 通用 source 兜底：团队全局文本默认模型
      const team = await this.prisma.team.findUnique({
        where: { id: membership.teamId },
        select: { defaultModelText: true },
      })
      return team?.defaultModelText ?? null
    } catch (e) {
      this.logger.warn(
        `resolveModelForLog user=${userId} source=${source}: ${(e as Error).message}`
      )
      return null
    }
  }

  /** 扣除 MCP 调用费用并记录流水 */
  async chargeMcp(userId: number, dto: ChargeMcpDto): Promise<ChargeResult> {
    if (
      dto.source &&
      dto.source !== "flow.workbench" &&
      Object.hasOwn(FIXED_MODULE_CREDITS, dto.source)
    ) {
      return {
        costCny: ZERO,
        creditsCharged: ZERO,
        balance: await this.credit.getConsumableBalanceRouted(userId),
        breakdown: [],
      }
    }

    const unit = await this.pricing.getMcpCallPrice()
    const cost = new Decimal(dto.calls).mul(unit)

    const result = await this.deduct(userId, cost, {
      type: UsageType.MCP,
      promptTokens: null,
      completionTokens: null,
      thinkingTokens: null,
      mcpCalls: dto.calls,
      inputCost: null,
      outputCost: null,
      source: dto.source,
      meta: this.withUsageChargeMeta(dto.meta, "mcp"),
      requestParams: dto.requestParams,
    })

    this.logger.log(
      `chargeMcp user=${userId} calls=${dto.calls} costCny=${cost.toString()} credits=${result.creditsCharged.toString()} balance=${result.balance.toString()}`
    )

    return result
  }

  /** 与 chargeMcp 使用相同单价和资金路由，供已持有业务行锁的调用方原子记账。
   * 唯一键冲突必须向外抛出，令外层事务整体回滚，不能吞掉后提交扣款。
   */
  async chargeMcpInTransaction(
    tx: Prisma.TransactionClient,
    userId: number,
    dto: ChargeMcpDto & { requestId: string },
    options: { invokeType?: InvokeType; unitPriceCny?: Decimal } = {}
  ): Promise<ChargeResult & { duplicate: boolean }> {
    if (!Number.isSafeInteger(dto.calls) || dto.calls <= 0)
      throw new BadRequestException("调用次数必须为正整数")
    if (!dto.requestId?.trim()) throw new BadRequestException("调用计费请求编号不能为空")
    const existing = await tx.usageLog.findUnique({ where: { requestId: dto.requestId } })
    if (existing) {
      if (
        existing.userId !== userId ||
        existing.source !== dto.source ||
        existing.type !== UsageType.MCP
      )
        throw new BadRequestException("调用计费请求编号已被占用")
      return {
        costCny: existing.cost,
        creditsCharged: existing.credits ?? ZERO,
        balance: existing.balanceAfter,
        breakdown: [],
        duplicate: true,
      }
    }
    // 服务端预检可锁定本次单价，防止上游取数期间调价突破接入方限额。
    const unitPrice = options.unitPriceCny ?? (await this.pricing.getMcpCallPrice())
    if (!unitPrice.isFinite() || unitPrice.lte(0))
      throw new BadRequestException("MCP 调用单价必须大于0")
    const cost = unitPrice.mul(dto.calls)
    const meta = this.withUsageChargeMeta(
      { ...dto.meta, mcpUnitPriceCny: unitPrice.toString() },
      "mcp"
    )
    const result = await this.consumeRouted(tx, userId, cost, {
      source: dto.source,
      meta,
      invokeType: options.invokeType,
    })
    await tx.usageLog.create({
      data: {
        userId,
        type: UsageType.MCP,
        mcpCalls: dto.calls,
        cost,
        credits: result.creditsCharged,
        balanceAfter: result.balanceAfter,
        source: dto.source,
        meta: meta as Prisma.InputJsonValue,
        requestId: dto.requestId,
        requestParams: dto.requestParams as Prisma.InputJsonValue | undefined,
      },
    })
    return {
      costCny: cost,
      creditsCharged: result.creditsCharged,
      balance: result.balanceAfter,
      breakdown: result.breakdown,
      duplicate: false,
    }
  }

  /**
   * 公共扣款：按人民币金额扣登录用户自己的积分（不走 token/视频计价口径，用于自定义计价场景）。
   * 复用 CreditService.consume——全系唯一的「人民币 → 积分」换算点（1元=10积分 × 用户折扣，
   * 向上取整）；换算比例 / 折扣若调整只此一处，调用方无须改。扣费内核与 AI 用量扣费完全一致
   * （桶优先级 FIFO + 行锁 + 跨池共享 + LV4 返利 + 跨桶流水）。
   * 只写积分流水（CreditTransaction CONSUME，积分明细可见），不写 UsageLog（无 token 用量语义）。
   * 后端模块可直接调（对任意 userId 扣）；HTTP 公共接口（POST /usage/deduct）只扣登录用户自己。
   */
  async deductCustom(
    userId: number,
    costCny: Decimal | number | string,
    opts: { source?: string; meta?: Record<string, unknown>; allowOverdraft?: boolean } = {}
  ): Promise<ChargeResult> {
    const cost = new Decimal(costCny)
    if (cost.lessThanOrEqualTo(0)) throw new BadRequestException("扣费金额必须大于 0")

    const source = opts.source ?? "manual.deduct"
    // 归属 active 企业 → 团队共享池扣费（含配额台账），否则个人扣费
    const res = await this.prisma.$transaction(
      tx =>
        this.consumeRouted(tx, userId, cost, {
          source,
          meta: opts.meta,
          allowOverdraft: opts.allowOverdraft,
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    )

    this.logger.log(
      `deductCustom user=${userId} costCny=${cost.toString()} credits=${res.creditsCharged.toString()} balance=${res.balanceAfter.toString()} source=${source}`
    )

    return {
      costCny: res.costCny,
      creditsCharged: res.creditsCharged,
      balance: res.balanceAfter,
      breakdown: res.breakdown,
    }
  }

  /**
   * 公共扣费 v2：大模型底座计费入口（按底座返回的人民币成本扣费，记录功能模块 + 模型用于用量统计）。
   * 与 deductCustom 的差异：① source 必填且须在 FeatureModule 注册表（未登记 400，杜绝自由串）；
   * ② model 必填（落 UsageLog.meta.model → 用量分析模型维度）；③ 写 UsageLog（积分明细 + 用量分析双可见）；
   * ④ requestId 幂等（重复提交返回首次结果）。扣费内核与全系一致（consumeRouted：归属 active 企业 → 团队共享池）。
   * 后端模块可直接调（对任意 userId 扣）；HTTP 端点（POST /usage/deduct/v2）只扣登录用户自己。
   */
  async chargeModel(
    userId: number,
    costCny: Decimal | number | string,
    params: ChargeModelParams
  ): Promise<ChargeModelResult> {
    const { cost, feature, meta } = await this.prepareChargeModel(costCny, params)
    let result: Awaited<ReturnType<UsageService["chargeModelTx"]>>
    try {
      result = await this.prisma.$transaction(
        tx => this.chargeModelTx(tx, userId, cost, params, meta),
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 }
      )
    } catch (e) {
      // 并发撞 requestId 唯一索引：本事务已整体回滚（未重复扣费），事务外重查返回首次结果
      if (params.requestId && this.isUniqueViolation(e)) {
        const dup = await this.findLogByRequestId(this.prisma, params.requestId)
        if (dup) result = { dup, consumeRes: null }
        else throw e
      } else {
        throw e
      }
    }
    return this.settleChargeModel(userId, params, feature, cost, result)
  }

  /**
   * chargeModel 的事务内核：供已持有外层事务的调用方复用（如 AI Gateway 回调——扣费必须与
   * 任务终态落库同事务原子完成）。注册表校验、requestId 幂等、consumeRouted 团队路由、
   * UsageLog 双写与 chargeModel 完全一致，仅事务边界由调用方负责。
   */
  async chargeModelInTransaction(
    tx: Prisma.TransactionClient,
    userId: number,
    costCny: Decimal | number | string,
    params: ChargeModelParams
  ): Promise<ChargeModelResult> {
    const { cost, feature, meta } = await this.prepareChargeModel(costCny, params)
    const result = await this.chargeModelTx(tx, userId, cost, params, meta)
    return this.settleChargeModel(userId, params, feature, cost, result)
  }

  async assertFixedModuleAffordable(
    userId: number,
    source: FixedModuleSource,
    operation?: string,
    generationBillingId?: string,
    quantity = 1
  ) {
    if (source === "listing.generate" && operation !== "optimization" && generationBillingId) {
      const paid = await this.prisma.usageLog.findFirst({
        where: {
          userId,
          source,
          requestId: listingGenerationChargeId(userId, generationBillingId),
        },
        select: { id: true },
      })
      if (paid) return { credits: 0 }
    }
    const credits = new Decimal(getFixedModuleCredits(source, operation, quantity))
    const billing = await this.resolveActiveBilling(this.prisma, userId)
    if (!billing) {
      await this.credit.assertAffordable(userId, credits.div(CREDIT_PER_CNY), credits)
      return { credits: credits.toNumber() }
    }
    const [gift, recharge, pool] = await Promise.all([
      this.credit.consumableBalance(this.prisma, userId, GIFT_LAYER_BUCKETS),
      this.credit.consumableBalance(this.prisma, userId, [CreditBucket.RECHARGE]),
      this.credit.teamPoolBalance(billing.teamId),
    ])
    const rest = Decimal.max(0, credits.minus(Decimal.max(0, gift)))
    const poolTake = Decimal.min(
      Decimal.max(0, pool),
      rest,
      this.teamQuotaCapCredits(billing) ?? rest
    )
    if (poolTake.greaterThan(0) && billing.team.quotaMode === TeamQuotaMode.INDEPENDENT) {
      const used = billing.quotaMonth === quotaMonthOf() ? billing.quotaUsedThisMonth : ZERO
      if (billing.monthlyQuota == null || poolTake.plus(used).greaterThan(billing.monthlyQuota))
        throw new BadRequestException("已达本月使用上限，请联系企业管理员调整额度")
    }
    if (rest.minus(poolTake).greaterThan(Decimal.max(0, recharge)))
      throw new BadRequestException(`积分余额不足，本次需要 ${credits.toString()} 积分`)
    return { credits: credits.toNumber() }
  }

  async chargeFixedModule(
    userId: number,
    source: FixedModuleSource,
    params: Omit<ChargeModelParams, "source" | "exactCredits"> & { quantity?: number },
    tx?: Prisma.TransactionClient
  ): Promise<ChargeModelResult> {
    const operation = typeof params.meta?.operation === "string" ? params.meta.operation : undefined
    const credits = getFixedModuleCredits(source, operation, params.quantity)
    const charge = {
      ...params,
      source,
      exactCredits: credits,
      meta: {
        ...params.meta,
        pricing: "fixed_module",
        unitCredits: getFixedModuleCredits(source, operation),
        quantity:
          source === "competitor.research" || source === "category.analysis"
            ? (params.quantity ?? 1)
            : 1,
        fixedCredits: credits,
        consumeEventId: randomUUID(),
      },
    }
    // 固定零售价作为计酬基数；真实上游成本留在 meta 供审计。
    return tx
      ? this.chargeModelInTransaction(tx, userId, credits / 10, charge)
      : this.chargeModel(userId, credits / 10, charge)
  }

  /** v2 扣费前置：金额/模型校验 + FeatureModule 注册表命中 + 组装 meta（盖 model/module 章） */
  private async prepareChargeModel(
    costCny: Decimal | number | string,
    params: ChargeModelParams
  ): Promise<{ cost: Decimal; feature: RegisteredFeature; meta: Record<string, unknown> }> {
    const cost = new Decimal(costCny)
    if (cost.lessThanOrEqualTo(0)) throw new BadRequestException("扣费金额必须大于 0")
    if (!params.model?.trim()) throw new BadRequestException("模型标识不能为空")
    const multiplier = new Decimal(params.creditMultiplier ?? 1)
    if (!multiplier.isPositive()) throw new BadRequestException("积分折算系数必须为正数")
    if (params.exactCredits !== undefined) {
      if (new Decimal(params.exactCredits).lessThanOrEqualTo(0))
        throw new BadRequestException("精确扣费积分必须大于 0")
      if (params.creditMultiplier !== undefined)
        throw new BadRequestException("exactCredits 与 creditMultiplier 不能同时使用")
    }

    await this.features.ensureFresh()
    const feature = this.features.get(params.source)
    if (!feature) throw new BadRequestException(`功能来源未登记：${params.source}`)

    const meta: Record<string, unknown> = {
      ...this.withUsageChargeMeta(params.meta, "model"),
      model: params.model,
      module: feature.module,
    }
    return { cost, feature, meta }
  }

  /**
   * 带业务操作 ID 的扣费额外盖一层“单次实际扣费”标识。
   *
   * businessEventId 用于把一次用户操作汇总成一条父记录；usageChargeId 用于把该操作内
   * 一次 Token/MCP/模型扣费因积分桶或个人/企业拆成的多条物理流水重新合成一条明细。
   * 没有业务操作 ID 的旧模块保持原样，避免改变其积分明细展示。
   */
  private withUsageChargeMeta(
    meta: Record<string, unknown> | undefined,
    usageKind: "token" | "mcp" | "model"
  ): Record<string, unknown> {
    const result = { ...(meta ?? {}) }
    if (typeof result.businessEventId !== "string" || !result.businessEventId.trim()) return result
    return {
      ...result,
      usageKind,
      usageChargeId: randomUUID(),
    }
  }

  /**
   * v2 扣费事务体：幂等先查 → consumeRouted → UsageLog 双写。
   * P2002（并发撞 requestId 唯一索引）不在事务内捕获（对齐 release 72af57c 修复：
   * 旧版捕获后正常返回会导致事务提交、并发双扣），异常向上抛令事务整体回滚，
   * 由 chargeModel 在事务外重查返回首次结果；chargeModelInTransaction 的调用方
   * （AI Gateway 回调）有任务行 gatewayEventId CAS 前置，同键并发本就只剩一个赢家。
   */
  private async chargeModelTx(
    tx: Prisma.TransactionClient,
    userId: number,
    cost: Decimal,
    params: ChargeModelParams,
    meta: Record<string, unknown>
  ): Promise<{
    dup: { cost: Decimal; credits: Decimal | null; balanceAfter: Decimal } | null
    consumeRes: ConsumeResult | null
  }> {
    // 幂等：先查后扣
    if (params.requestId) {
      const dup = await this.findLogByRequestId(tx, params.requestId)
      if (dup) return { dup, consumeRes: null }
    }
    const multiplier = new Decimal(params.creditMultiplier ?? 1)
    // 精确积分模式：跳过折扣/系数换算，按给定积分值直扣（一口价即最终价）；
    // cost 仍传名义售价（积分÷CREDIT_PER_CNY），段成本按比例切分供返利/对账
    const exactCredits =
      params.exactCredits !== undefined ? new Decimal(params.exactCredits) : undefined
    const consumeRes = await this.consumeRouted(
      tx,
      userId,
      exactCredits ? cost : multiplier.eq(1) ? cost : cost.mul(multiplier),
      {
        source: params.source,
        meta,
        allowOverdraft: params.allowOverdraft,
        invokeType: params.invokeType,
      },
      exactCredits
    )
    // usageLog 与扣减同事务：写日志失败（含 P2002 撞幂等键）整事务回滚，不在此捕获
    await tx.usageLog.create({
      data: {
        userId,
        type: UsageType.TOKEN, // 沿用视频/精确积分惯例（admin 统计 type=TOKEN 自动包含）
        cost,
        credits: consumeRes.creditsCharged,
        balanceAfter: consumeRes.balanceAfter,
        source: params.source,
        meta: meta as Prisma.InputJsonValue,
        requestId: params.requestId ?? null,
      },
    })
    return { dup: null, consumeRes }
  }

  /** v2 扣费收口：幂等命中返回首次结果，否则返回本次扣费结果 */
  private settleChargeModel(
    userId: number,
    params: ChargeModelParams,
    feature: RegisteredFeature,
    cost: Decimal,
    result: Awaited<ReturnType<UsageService["chargeModelTx"]>>
  ): ChargeModelResult {
    if (result.dup) {
      this.logger.log(
        `chargeModel duplicate user=${userId} requestId=${params.requestId} → 返回首次扣费结果`
      )
      return {
        costCny: result.dup.cost,
        creditsCharged: result.dup.credits ?? ZERO,
        balance: result.dup.balanceAfter ?? ZERO,
        breakdown: [],
        source: feature.source,
        sourceLabel: feature.label,
        module: feature.module,
        moduleLabel: feature.moduleLabel,
        model: params.model,
        requestId: params.requestId ?? null,
        duplicate: true,
      }
    }

    const consumeRes = result.consumeRes
    if (!consumeRes) throw new BadRequestException("扣费失败") // 理论不可达（dup/consumeRes 必居其一）
    this.logger.log(
      `chargeModel user=${userId} costCny=${cost.toString()} credits=${consumeRes.creditsCharged.toString()} balance=${consumeRes.balanceAfter.toString()} source=${params.source} model=${params.model}`
    )
    return {
      costCny: cost, // 真实人民币金额(系数≠1 时 consumeRes.costCny 是放大后值,不外露)
      creditsCharged: consumeRes.creditsCharged,
      balance: consumeRes.balanceAfter,
      breakdown: consumeRes.breakdown,
      source: feature.source,
      sourceLabel: feature.label,
      module: feature.module,
      moduleLabel: feature.moduleLabel,
      model: params.model,
      requestId: params.requestId ?? null,
      duplicate: false,
    }
  }

  /** 按幂等键查 UsageLog（重复提交判定） */
  private findLogByRequestId(client: Prisma.TransactionClient | PrismaService, requestId: string) {
    return client.usageLog.findUnique({
      where: { requestId },
      select: { cost: true, credits: true, balanceAfter: true },
    })
  }

  private isUniqueViolation(e: unknown): boolean {
    return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  }

  /**
   * 在外层事务中按业务已确定的精确积分售价扣费，并写入 UsageLog。
   * 不再应用会员折扣或整数向上取整，适用于 9.6 这类小数积分定价。
   */
  async chargeExactCreditsInTransaction(
    tx: Prisma.TransactionClient,
    userId: number,
    dto: ChargeExactCreditsParams
  ): Promise<ChargeResult> {
    const credits = new Decimal(dto.credits)
    const cost = new Decimal(dto.costCny)
    if (credits.lessThanOrEqualTo(0)) throw new BadRequestException("扣费积分必须大于 0")
    if (cost.lessThan(0)) throw new BadRequestException("扣费金额不能为负")

    const consumeRes = await this.consumeRouted(
      tx,
      userId,
      cost,
      {
        source: dto.source,
        meta: dto.meta,
        allowOverdraft: dto.allowOverdraft,
      },
      credits
    )

    await tx.usageLog.create({
      data: {
        userId,
        type: UsageType.TOKEN,
        promptTokens: null,
        completionTokens: null,
        thinkingTokens: null,
        mcpCalls: null,
        inputCost: null,
        outputCost: null,
        cost,
        credits: consumeRes.creditsCharged,
        balanceAfter: consumeRes.balanceAfter,
        source: dto.source,
        meta: dto.meta as Prisma.InputJsonValue | undefined,
      },
    })

    this.logger.log(
      `chargeExactCredits user=${userId} costCny=${cost.toString()} credits=${consumeRes.creditsCharged.toString()} balance=${consumeRes.balanceAfter.toString()} source=${dto.source}`
    )

    return {
      costCny: cost,
      creditsCharged: consumeRes.creditsCharged,
      balance: consumeRes.balanceAfter,
      breakdown: consumeRes.breakdown,
    }
  }

  /** Gateway 提交预检：路由口径（归属 active 企业校验团队共享池，否则个人），与 v2 扣费内核一致 */
  async assertGatewayAffordable(userId: number, amountCny: Decimal | string): Promise<void> {
    await this.assertAffordableRouted(userId, new Decimal(amountCny))
  }

  /**
   * 模型价格倍率（AiGatewayModel.priceMultiplier）：网关 usage 与报价统一乘以该倍率后计费/展示。
   * 目录缺行/字段空/非法一律按 1；提供业务类别时精确匹配，旧的无类别调用保持原行为。
   */
  async gatewayPriceMultiplier(publicId: string, category?: string): Promise<Decimal> {
    const row = await this.prisma.aiGatewayModel.findFirst({
      where: { publicId, ...(category !== undefined ? { category } : {}) },
      select: { priceMultiplier: true },
    })
    return safeMultiplier(row?.priceMultiplier)
  }

  /**
   * 图片固定一口价（积分/张）：按 (publicId, category) 实时读库。配置后生图按
   * 「fixedCredits × 成功张数」精确扣费（exactCredits，不打折）；未配置（NULL/缺行/
   * 禁用/非法）返回 null，调用方回落按量计费。扣费前实时查询，数据库改值即时生效。
   */
  async gatewayFixedImageCredits(publicId: string, category: string): Promise<Decimal | null> {
    const row = await this.prisma.aiGatewayModel.findFirst({
      where: { publicId, category, enabled: true, gatewayActive: true },
      select: { fixedCredits: true },
    })
    if (!row?.fixedCredits) return null
    const value = new Decimal(row.fixedCredits)
    // decimal.js 的 isPositive() 对 0 返回 true，这里必须严格 greaterThan(0)，
    // 否则误配 0 会进入固定价路径扣 0 积分
    return value.greaterThan(0) ? value : null
  }

  /**
   * 视频固定一口价（积分/秒）：按 (publicId, category) 实时读 AiGatewayVideoFixedPrice 全部行，
   * 键 = `mode|分辨率档`（各自小写归一，mode 空串 = 通配行），值严格 >0（0/负值行跳过该档）。
   * 无有效行返回 null，调用方回落按量计费。扣费前实时查询，数据库改值即时生效。
   */
  async gatewayFixedVideoCreditsPerSec(
    publicId: string,
    category: string
  ): Promise<Map<string, Decimal> | null> {
    const rows = await this.prisma.aiGatewayVideoFixedPrice.findMany({
      where: { publicId, category },
      select: { mode: true, resolution: true, creditsPerSec: true },
    })
    const map = new Map<string, Decimal>()
    for (const row of rows) {
      const resolution = row.resolution?.trim().toLowerCase()
      if (!resolution || row.creditsPerSec == null) continue
      const mode = row.mode?.trim().toLowerCase() ?? ""
      // 同 gatewayFixedImageCredits：严格 greaterThan(0)，防误配 0 进入固定价路径
      const value = new Decimal(row.creditsPerSec)
      if (value.greaterThan(0)) map.set(`${mode}|${resolution}`, value)
    }
    return map.size ? map : null
  }

  /**
   * gatewayFixedVideoCreditsPerSec 的单档读取（带档位语义）：mode/resolution 小写归一后查档，
   * 先精确 mode 行、再退 mode='' 通配行（同分辨率按模式分价时未传 mode 的兜底）。
   * 带分辨率未命中精确档 → 兜底查 `flat` 按次档（flat=true，不乘时长，同模型不分时长/分辨率一口价时用）。
   * 请求/终态都没有分辨率（自适应模型，如 Kling O3）→ 兜底查 `adaptive` 保留档，
   * 该档同为「按次一口价」语义。缺档返回 null（调用方回落按量）。
   * 预检、报价、回调扣费共用。
   */
  async resolveFixedVideoTier(
    publicId: string,
    category: string,
    resolution: string | null | undefined,
    mode?: string | null
  ): Promise<{ creditsPerSec: Decimal; flat: boolean } | null> {
    const map = await this.gatewayFixedVideoCreditsPerSec(publicId, category)
    if (!map) return null
    const modeKey = mode?.trim().toLowerCase() ?? ""
    const key = resolution?.trim().toLowerCase()
    if (key) {
      const hit = map.get(`${modeKey}|${key}`) ?? map.get(`|${key}`)
      if (hit) return { creditsPerSec: hit, flat: false }
      const flat = map.get(`${modeKey}|flat`) ?? map.get("|flat")
      return flat ? { creditsPerSec: flat, flat: true } : null
    }
    const adaptive = map.get(`${modeKey}|adaptive`) ?? map.get("|adaptive")
    return adaptive ? { creditsPerSec: adaptive, flat: true } : null
  }

  async resolveFixedVideoCreditsPerSec(
    publicId: string,
    category: string,
    resolution: string | null | undefined,
    mode?: string | null
  ): Promise<Decimal | null> {
    return (
      (await this.resolveFixedVideoTier(publicId, category, resolution, mode))?.creditsPerSec ??
      null
    )
  }

  /**
   * 在外层事务中扣除视频费用，用于和视频任务成功落库保持原子性。
   * 计费口径：请求时长 × (模型 × 分辨率) 成本价 × 加价倍数；自动时长（-1）按固定秒数计费。
   */
  async chargeVideoInTransaction(
    tx: Prisma.TransactionClient,
    userId: number,
    dto: ChargeVideoParams
  ): Promise<ChargeResult> {
    const quote = this.quoteVideoCharge(dto)
    return this.chargeVideoWithClient(tx, userId, dto, quote)
  }

  /**
   * 提交预检：按预估视频成本（含用户折扣）校验积分余额，不足抛 400，避免白跑生成。
   * 固定时长请求 = 精确成本；自动时长档按兜底秒数估。出片后仍以实际成本结算。
   */
  async assertVideoAffordable(userId: number, dto: ChargeVideoParams): Promise<void> {
    const quote = this.quoteVideoCharge(dto)
    await this.assertAffordableRouted(userId, quote.cost)
  }

  /** 批量视频提交预检：按整批预计成本校验余额，避免逐条校验时低估总费用。 */
  async assertVideosAffordable(userId: number, tasks: ChargeVideoParams[]): Promise<void> {
    const total = tasks.reduce((sum, task) => sum.add(this.quoteVideoCharge(task).cost), ZERO)
    await this.assertAffordableRouted(userId, total)
  }

  /**
   * 固定一口价余额预检：按给定积分值（不打折口径）校验，路由口径与 consumeRouted 一致
   * （归属 active 企业 → 个人可消费+企业池合计，否则个人；池/配额不足会落个人段兜底）。
   */
  async assertExactCreditsAffordable(
    userId: number,
    credits: Decimal | string | number
  ): Promise<void> {
    const required = new Decimal(credits)
    const billing = await this.resolveActiveBilling(this.prisma, userId)
    const [personal, pool] = await Promise.all([
      this.credit.getConsumableBalance(userId),
      billing ? this.credit.teamPoolBalance(billing.teamId) : Promise.resolve(ZERO),
    ])
    if (personal.plus(pool).lessThan(required)) {
      throw new BadRequestException(`积分余额不足，本次需 ${required.toString()} 积分`)
    }
  }

  /** 余额预检路由：归属 active 企业 → 与 consumeRouted 同口径校验（个人可消费+企业池合计；池/配额不足会落个人段兜底），否则个人（含邀请人共享额度） */
  private async assertAffordableRouted(userId: number, cost: Decimal): Promise<void> {
    const billing = await this.resolveActiveBilling(this.prisma, userId)
    if (billing == null) return this.credit.assertAffordable(userId, cost)
    // 双费率取保守上限：全量按较贵的费率估（池段实际可能更便宜）——预检宁严勿漏，实扣以 consumeRouted 为准
    const userRate = await this.userEffectiveRate(this.prisma, userId)
    const poolRate = new Decimal(billing.team.discount).mul(CREDIT_PER_CNY)
    const credits = cost.mul(Decimal.max(userRate, poolRate)).ceil()
    const [personal, pool] = await Promise.all([
      this.credit.getConsumableBalance(userId),
      this.credit.teamPoolBalance(billing.teamId),
    ])
    if (personal.plus(pool).lessThan(credits)) {
      throw new BadRequestException(`积分余额不足，无法生成（预计需 ${credits.toString()} 积分）`)
    }
  }

  /**
   * 启动期校验：传入的 (模型, 分辨率档位) 组合都已配置单价。
   * 避免出片成功后才在扣费事务里抛 BadRequestException 导致回滚丢片——
   * 把"漏配价格"从运行时风险提前到进程启动时立刻暴露。
   */
  assertVideoPricingCovered(mode: string, model: string, resolutions: string[]): void {
    // 无分辨率档位的模型（如常规模式 video-lite）按 model 单价兜底校验一次
    const probes = resolutions.length > 0 ? resolutions : [null]
    for (const resolution of probes) {
      try {
        const dto = { mode, model, resolution } as ChargeVideoParams
        // 固定价模型走固定价表，其余走按秒成本价表，任一命中即视为已配置
        if (!this.resolveFixedVideoPrice(dto)) this.resolveVideoUnitPrice(dto)
      } catch {
        throw new Error(
          `视频计费缺少单价配置：mode=${mode} model=${model} resolution=${resolution ?? "(无)"}，请补充价格表`
        )
      }
    }
  }

  /**
   * 能力下发展示用：返回模型预计扣分（积分/秒）。
   * 仅用于前端展示，不参与实际扣费；口径与实际扣费一致（成本价 × VIDEO_MARKUP，再按 1元=10积分换算）。
   */
  getVideoCreditsPerSecondPreview(params: {
    mode: string
    model: string
    resolutions?: string[]
    defaultResolution?: string | null
  }): VideoCreditsPerSecondPreview | null {
    const probes = (
      params.resolutions?.length ? params.resolutions : [params.defaultResolution ?? null]
    ).filter((v, idx, arr) => arr.indexOf(v) === idx)
    const rates = new Map<string, number>()
    for (const resolution of probes) {
      const dto = {
        mode: params.mode,
        model: params.model,
        durationSec: 1,
        resolution,
      } as ChargeVideoParams

      // 固定每次生成价模型（如 video-flash-reference）无法给出统一“每秒扣分”，这里返回 null 由调用方决定展示策略
      if (this.resolveFixedVideoPrice(dto)) return null

      const unitPriceCnyPerSec = this.resolveVideoUnitPrice(dto).price.mul(VIDEO_MARKUP)
      // 展示值不保留小数，按整数向上取整，避免低估预计扣分
      const creditsPerSec = Number(unitPriceCnyPerSec.mul(10).ceil().toString())
      rates.set(resolution ?? "__auto__", creditsPerSec)
    }

    if (rates.size === 0) return null
    const values = [...rates.values()]
    const defaultRate = rates.get(params.defaultResolution ?? "__auto__") ?? values[0]
    return {
      default: defaultRate,
      min: Math.min(...values),
      max: Math.max(...values),
    }
  }

  /** 查询积分钱包（各桶余额 + 等级 + 本月已用 + 累计消耗）。已切积分口径，复用 CreditService。 */
  async getBalance(userId: number) {
    return this.credit.getWallet(userId)
  }

  /**
   * 用量 / 积分明细「来源」筛选下拉项（value=完整 source、label=中文）。
   * 实时由 FeatureModule 注册表合并静态兜底派生（同源于「项目」列文案），供前端渲染下拉、不再硬编码。
   */
  getSourceOptions() {
    return getUsageSourceOptions()
  }

  /** 分页查询用量流水 */
  async listLogs(userId: number, query: QueryUsageLogsDto) {
    const { page, pageSize, type } = query
    const skip = (page - 1) * pageSize
    const where: Prisma.UsageLogWhereInput = { userId, ...(type && { type }) }

    const [items, total] = await Promise.all([
      this.prisma.usageLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      this.prisma.usageLog.count({ where }),
    ])

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  /** 按用户聚合：剩余积分 + 时间段内已消耗积分（TOKEN/视频通道），已消耗 DESC（admin 专用），无记录用户也返回 */
  async statsByUser(query: QueryUsageStatsDto): Promise<UsageStatsByUserItemDto[]> {
    const where: Prisma.UsageLogWhereInput = {
      type: UsageType.TOKEN,
      ...this.buildPeriodWhere(query.period),
    }

    const [users, grouped] = await Promise.all([
      this.prisma.user.findMany({
        select: {
          id: true,
          username: true,
          phone: true,
          canInvite: true,
          invitedById: true,
          subscriptionTier: true,
          roles: userRolesSelect,
        },
        orderBy: { id: "asc" },
      }),
      this.prisma.usageLog.groupBy({
        by: ["userId"],
        where,
        _sum: {
          credits: true,
          promptTokens: true,
          completionTokens: true,
          thinkingTokens: true,
        },
      }),
    ])

    const aggByUserId = new Map(grouped.map(g => [g.userId, g]))
    const balByUser = await this.consumableByUsers(users.map(u => u.id))

    const items: UsageStatsByUserItemDto[] = users.map(u => {
      const g = aggByUserId.get(u.id)
      const consumed = g?._sum.credits ?? ZERO
      const remaining = balByUser.get(u.id) ?? ZERO
      const tokens =
        (g?._sum.promptTokens ?? 0) +
        (g?._sum.completionTokens ?? 0) +
        (g?._sum.thinkingTokens ?? 0)
      return {
        userId: u.id,
        username: u.username,
        phone: u.phone,
        level: resolveLevel(u),
        totalQuota: remaining.plus(consumed).toString(), // 总积分 = 剩余 + 时段内已消耗（沿用「总额度=剩余+已消耗」口径）
        remaining: remaining.toString(),
        totalConsumed: consumed.toString(),
        totalTokens: tokens,
        roles: mergeUserRoles(u.roles),
        permissions: mergeUserPermissions(u.roles),
      }
    })

    items.sort((a, b) => new Decimal(b.totalConsumed).comparedTo(a.totalConsumed))
    return items
  }

  /** 指定用户按 source 拆分的已消耗积分明细（admin 专用） */
  async statsSourcesByUser(
    userId: number,
    query: QueryUsageStatsDto
  ): Promise<UsageStatsSourceItemDto[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    })
    if (!user) throw new NotFoundException("用户不存在")

    const where: Prisma.UsageLogWhereInput = {
      userId,
      type: UsageType.TOKEN,
      source: { not: null },
      ...this.buildPeriodWhere(query.period),
    }

    const grouped = await this.prisma.usageLog.groupBy({
      by: ["source"],
      where,
      _sum: {
        credits: true,
        promptTokens: true,
        completionTokens: true,
        thinkingTokens: true,
      },
      _count: { _all: true },
      orderBy: { _sum: { credits: "desc" } },
    })

    return grouped.map(g => {
      const tokens =
        (g._sum.promptTokens ?? 0) + (g._sum.completionTokens ?? 0) + (g._sum.thinkingTokens ?? 0)
      return {
        source: g.source ?? "",
        totalConsumed: (g._sum.credits ?? new Decimal(0)).toString(),
        totalTokens: tokens,
        callCount: g._count._all,
      }
    })
  }

  /** 全站汇总：剩余积分 / 已消耗积分 / 总消耗 tokens（admin 专用） */
  async statsSummary(query: QueryUsageStatsDto): Promise<UsageStatsSummaryDto> {
    const where: Prisma.UsageLogWhereInput = {
      type: UsageType.TOKEN,
      ...this.buildPeriodWhere(query.period),
    }

    const [userCount, logAgg, lotAgg] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.usageLog.aggregate({
        where,
        _sum: {
          credits: true,
          promptTokens: true,
          completionTokens: true,
          thinkingTokens: true,
        },
      }),
      this.prisma.creditLot.aggregate({
        where: {
          bucket: { in: [CreditBucket.RECHARGE, CreditBucket.PACKAGE, CreditBucket.GIFT] },
          status: "ACTIVE",
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        _sum: { remaining: true },
      }),
    ])

    const totalTokens =
      (logAgg._sum.promptTokens ?? 0) +
      (logAgg._sum.completionTokens ?? 0) +
      (logAgg._sum.thinkingTokens ?? 0)

    const remaining = lotAgg._sum.remaining ?? ZERO
    const totalCost = logAgg._sum.credits ?? ZERO
    return {
      userCount,
      totalQuota: remaining.plus(totalCost).toString(), // 总额度 = 剩余 + 已消耗（沿用老看板口径）
      totalCost: totalCost.toString(),
      remaining: remaining.toString(),
      totalTokens,
    }
  }

  /** 各用户可消费积分余额（RECHARGE+PACKAGE+GIFT，ACTIVE 未过期）。 */
  private async consumableByUsers(userIds: number[]): Promise<Map<number, Decimal>> {
    const map = new Map<number, Decimal>()
    if (userIds.length === 0) return map
    const grouped = await this.prisma.creditLot.groupBy({
      by: ["userId"],
      where: {
        userId: { in: userIds },
        bucket: { in: [CreditBucket.RECHARGE, CreditBucket.PACKAGE, CreditBucket.GIFT] },
        status: "ACTIVE",
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      _sum: { remaining: true },
    })
    for (const g of grouped) map.set(g.userId, g._sum.remaining ?? ZERO)
    return map
  }

  /** 解析时间维度为 createdAt 区间：默认 THIS_MONTH；ALL 返回空 */
  private buildPeriodWhere(period?: StatsPeriod): Pick<Prisma.UsageLogWhereInput, "createdAt"> {
    const resolved = period ?? StatsPeriod.THIS_MONTH
    if (resolved === StatsPeriod.ALL) return {}

    const now = new Date()
    switch (resolved) {
      case StatsPeriod.LAST_7_DAYS: {
        const from = new Date(now)
        from.setDate(from.getDate() - 7)
        return { createdAt: { gte: from } }
      }
      case StatsPeriod.THIS_MONTH: {
        // 北京自然月口径（容器 UTC 时每月 1 日 00:00–08:00 不错算上月）
        return { createdAt: { gte: beijingMonthStart(now) } }
      }
      case StatsPeriod.LAST_MONTH: {
        const from = beijingMonthStart(now, -1)
        const to = beijingMonthStart(now)
        return { createdAt: { gte: from, lt: to } }
      }
    }
  }

  /**
   * 消费路由：归属 active 企业（成员 ACTIVE 且团队 ACTIVE）→ 混合扣费，否则走个人扣费
   * （consume / consumeCredits）。返回结构与 ConsumeResult 一致，UsageLog 记录不变。
   *
   * 混合扣费顺序（TEAM_MEMBER_FUNDING_ORDER，全消费链路通用：v1/v2/对外开放/视频结算）：
   *   ① 个人赠送层（PACKAGE+GIFT，30 天过期先烧）→ ② 企业共享池 → ③ 个人充值（RECHARGE，永不过期最后扣）。
   * 企业成员加入时个人套餐/赠送已清零，故常态表现 = 企业池 → 个人充值（个人充值包积分兜底）。
   * 预留：产品以后可配「先企业还是先个人」时，从 TEAM_MEMBER_FUNDING_ORDER 派生下方分段顺序。
   *
   * 分段语义：配额台账只记企业段（个人段不动配额，配额 BLOCK 仍整体报错）；返利各段各自口径
   * （企业段按 RebateRule.corpCounts，个人段按个人规则）；透支兜底落个人充值段（欠账记成员个人户）。
   * 锁序固定：个人批次 → 企业池批次（全系统唯一双锁路径，防死锁）。
   * 混合事件（个人与企业都扣）给本笔全部流水盖「事件章」（meta.consumeEventId + ownershipSplit
   * 双归属拆分与双剩余快照），供积分明细渲染「双标签 / 悬浮拆分 / 个人剩余+企业剩余」。
   */
  private async consumeRouted(
    tx: Prisma.TransactionClient,
    userId: number,
    cost: Decimal,
    opts: {
      source?: string
      meta?: Record<string, unknown>
      allowOverdraft?: boolean
      invokeType?: InvokeType
    },
    exactCredits?: Decimal
  ): Promise<ConsumeResult> {
    const billing = await this.resolveActiveBilling(tx, userId)
    const teamId = billing?.teamId ?? null
    if (teamId == null) {
      return exactCredits
        ? this.credit.consumeCredits(userId, exactCredits, cost, opts, tx)
        : this.credit.consume(userId, cost, opts, tx)
    }
    // 费率（积分/元）：个人段 = 成员生效折扣（canInvite=false 且有邀请人 → 跟随上级），
    // 企业池段 = 共享池计价折扣 Team.discount（2026-09-02 定稿：此前 Team.discount 从未参与扣费）。
    // exactCredits 为业务方给定的精确积分口径，不做任何折扣换算。
    const userRate = exactCredits ? null : await this.userEffectiveRate(tx, userId)
    const teamRate = exactCredits ? null : new Decimal(billing!.team.discount).mul(CREDIT_PER_CNY)
    // 双费率不一致（定制企业合同折扣 ≠ 成员生效折扣）→ 按成本顺序切段、段内各自取整；
    // 一致（如 SELF 企业固定 1）→ 单费率老口径：总额一次取整、按积分空间切分（与历史行为逐分一致）
    const dualRate = userRate != null && teamRate != null && !teamRate.equals(userRate)

    const credits = exactCredits ?? cost.mul(userRate!).ceil()
    if (credits.lessThanOrEqualTo(0)) {
      // 与 consumeInTx 零扣减口径一致：不落池扣减，仅返回当前池余额
      const balanceAfter = await this.credit.teamPoolBalance(teamId, tx)
      return { creditsCharged: new Decimal(0), costCny: cost, breakdown: [], balanceAfter }
    }

    // 预读（带锁）：先锁个人批次算赠送段，不足再锁企业池算企业段，剩余落个人充值段
    const personal = await this.credit.lockPersonalBalancesInTx(tx, userId)
    let giftTake: Decimal
    let teamTake = ZERO
    let rechargeTake: Decimal
    // 各段人民币成本（仅供返利/对账参考，积分才是结算单位）：双费率按段实际换算，单费率按积分占比切分
    let giftCost = ZERO
    let teamCost = ZERO
    let rechargeCost = ZERO
    let poolBefore = ZERO
    if (!dualRate) {
      const shareOf = (part: Decimal) => cost.mul(part).div(credits)
      giftTake = Decimal.min(Decimal.max(personal.giftLayer, ZERO), credits)
      let rest = credits.minus(giftTake)
      if (rest.greaterThan(0)) {
        poolBefore = await this.credit.lockTeamPoolBalanceInTx(tx, teamId)
        // 「阻止使用」（SHARED+BLOCK）阻止的是企业池、不是个人：企业段按本月配额剩余封顶，
        // 超出配额的部分落个人充值段（quotaMonth 跨月按懒重置口径视为 0 已用，读时推导不写库）
        const teamCap = this.teamQuotaCapCredits(billing!) ?? rest
        teamTake = Decimal.min(Decimal.max(poolBefore, ZERO), rest, teamCap)
        rest = rest.minus(teamTake)
      }
      rechargeTake = rest
      giftCost = shareOf(giftTake)
      teamCost = shareOf(teamTake)
      rechargeCost = shareOf(rechargeTake)
    } else {
      const uRate = userRate
      const tRate = teamRate
      // 赠送层（个人率）：能吃掉的成本 = 层内积分 ÷ 个人率
      giftTake = Decimal.min(Decimal.max(personal.giftLayer, ZERO), cost.mul(uRate).ceil())
      giftCost = giftTake.div(uRate)
      let restCost = cost.minus(giftCost)
      if (restCost.greaterThan(0)) {
        poolBefore = await this.credit.lockTeamPoolBalanceInTx(tx, teamId)
        // 池段（池率）：受池余额与本月配额剩余（均为积分口径）封顶，超出落个人充值段
        const desired = restCost.mul(tRate).ceil()
        const teamCap = this.teamQuotaCapCredits(billing!) ?? desired
        teamTake = Decimal.min(Decimal.max(poolBefore, ZERO), desired, teamCap)
        teamCost = teamTake.div(tRate)
        restCost = restCost.minus(teamCost)
      }
      // 个人充值段（个人率）：剩余成本兜底
      rechargeCost = restCost
      rechargeTake = rechargeCost.mul(uRate).ceil()
    }
    const personalTake = giftTake.plus(rechargeTake)

    // 事件章（仅混合事件需要；纯单归属事件的行由 teamId 天然区分，读取侧直接推导）
    const mixed = personalTake.greaterThan(0) && teamTake.greaterThan(0)
    const meta = mixed
      ? {
          ...opts.meta,
          consumeEventId: randomUUID(),
          ownershipSplit: {
            personal: personalTake.toString(),
            team: teamTake.toString(),
            personalBalanceAfter: personal.total.minus(personalTake).toString(),
            teamBalanceAfter: poolBefore.minus(teamTake).toString(),
          },
        }
      : opts.meta
    const childOpts = { source: opts.source, meta, invokeType: opts.invokeType }

    const breakdown: ConsumeBreakdownItem[] = []
    let balanceAfter = personal.total
    if (giftTake.greaterThan(0)) {
      const r = await this.credit.consumeCredits(
        userId,
        giftTake,
        giftCost,
        {
          ...childOpts,
          bucketScope: GIFT_LAYER_BUCKETS,
          skipInviterShare: true,
        },
        tx
      )
      breakdown.push(...r.breakdown)
      balanceAfter = r.balanceAfter
    }
    if (teamTake.greaterThan(0)) {
      const r = await this.teamQuota.deductWithQuota(
        teamId,
        userId,
        teamTake,
        teamCost,
        childOpts,
        tx
      )
      breakdown.push(...r.breakdown)
      balanceAfter = r.balanceAfter
    }
    if (rechargeTake.greaterThan(0)) {
      const r = await this.credit.consumeCredits(
        userId,
        rechargeTake,
        rechargeCost,
        {
          ...childOpts,
          allowOverdraft: opts.allowOverdraft, // 透支只落最后的个人充值段（欠账记成员个人户）
          bucketScope: [CreditBucket.RECHARGE],
          skipInviterShare: true,
        },
        tx
      )
      breakdown.push(...r.breakdown)
      balanceAfter = r.balanceAfter
    }
    // 双费率口径下三段各自取整，实际扣减 = 三段合计（与单费率总额一次取整不同源）
    const totalCharged = dualRate ? giftTake.plus(teamTake).plus(rechargeTake) : credits
    return { creditsCharged: totalCharged, costCny: cost, breakdown, balanceAfter }
  }

  /**
   * 用户当前归属的 active 企业扣费上下文（成员 ACTIVE 且团队 ACTIVE），无则 null。
   * GRACE/ARCHIVED 企业走个人计费。带配额字段（SHARED+BLOCK 封顶拆分用）。
   */
  private async resolveActiveBilling(
    client: Prisma.TransactionClient | PrismaService,
    userId: number
  ) {
    return client.teamMember.findFirst({
      where: { userId, status: TeamMemberStatus.ACTIVE, team: { status: TeamStatus.ACTIVE } },
      select: {
        teamId: true,
        monthlyQuota: true,
        quotaUsedThisMonth: true,
        quotaMonth: true,
        team: { select: { quotaMode: true, overLimitPolicy: true, discount: true } },
      },
    })
  }

  /** 成员个人段费率（积分/元）：CREDIT_PER_CNY × 成员生效折扣（canInvite=false 且有邀请人 → 跟随上级） */
  private async userEffectiveRate(
    client: Prisma.TransactionClient | PrismaService,
    userId: number
  ): Promise<Decimal> {
    const user = await client.user.findUnique({
      where: { id: userId },
      select: { id: true, canInvite: true, discount: true, invitedById: true },
    })
    const discount = user
      ? await this.credit.resolveEffectiveDiscount(client, user)
      : new Decimal(1)
    return discount.mul(CREDIT_PER_CNY)
  }

  /** 企业配额段封顶（积分）：仅 SHARED+BLOCK 且设了月度配额时封顶本月剩余，否则 null=不封顶 */
  private teamQuotaCapCredits(
    billing: NonNullable<Awaited<ReturnType<UsageService["resolveActiveBilling"]>>>
  ): Decimal | null {
    if (
      billing.team.quotaMode === TeamQuotaMode.SHARED &&
      billing.team.overLimitPolicy === OverLimitPolicy.BLOCK &&
      billing.monthlyQuota != null
    ) {
      const quotaUsed =
        billing.quotaMonth === quotaMonthOf() ? new Decimal(billing.quotaUsedThisMonth) : ZERO
      return Decimal.max(ZERO, new Decimal(billing.monthlyQuota).minus(quotaUsed))
    }
    return null
  }

  /** 事务：扣余额 + 累加消费 + 写流水 */
  private async deduct(
    userId: number,
    cost: Decimal,
    log: {
      type: UsageType
      promptTokens: number | null
      completionTokens: number | null
      thinkingTokens: number | null
      mcpCalls: number | null
      inputCost: Decimal | null
      outputCost: Decimal | null
      source?: string
      meta?: Record<string, unknown>
      requestParams?: Record<string, unknown>
      invokeType?: InvokeType
    }
  ) {
    return this.prisma.$transaction(
      async tx => {
        // 扣积分（归属 active 企业走团队共享池，否则个人：折扣换算 + 桶优先级 + FIFO + 行锁 + 跨桶流水 + 返利）
        const consumeRes = await this.consumeRouted(tx, userId, cost, {
          source: log.source,
          meta: log.meta,
          ...(log.invokeType ? { invokeType: log.invokeType } : {}),
        })

        // UsageLog 仍记 AI 用量（token 明细 + 人民币成本）；balanceAfter 改记积分余额
        await tx.usageLog.create({
          data: {
            userId,
            type: log.type,
            promptTokens: log.promptTokens,
            completionTokens: log.completionTokens,
            thinkingTokens: log.thinkingTokens,
            mcpCalls: log.mcpCalls,
            inputCost: log.inputCost,
            outputCost: log.outputCost,
            cost,
            credits: consumeRes.creditsCharged,
            balanceAfter: consumeRes.balanceAfter,
            source: log.source,
            meta: log.meta as Prisma.InputJsonValue | undefined,
            requestParams: log.requestParams as Prisma.InputJsonValue | undefined,
          },
        })

        return {
          costCny: cost,
          creditsCharged: consumeRes.creditsCharged,
          balance: consumeRes.balanceAfter,
          breakdown: consumeRes.breakdown,
        }
        // READ COMMITTED：并发扣费时锁后重读批次读到最新已提交值，避免丢失更新（少扣/余额对不上）
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: USAGE_TRANSACTION_MAX_WAIT_MS,
        timeout: USAGE_TRANSACTION_TIMEOUT_MS,
      }
    )
  }

  private async chargeVideoWithClient(
    tx: Prisma.TransactionClient,
    userId: number,
    dto: ChargeVideoParams,
    quote: VideoChargeQuote
  ): Promise<ChargeResult> {
    const meta = {
      ...(dto.meta ?? {}),
      mode: dto.mode,
      model: dto.model,
      modelId: dto.modelId ?? null,
      projectId: dto.projectId ?? null,
      taskId: dto.taskId ?? null,
      requestedDurationSec: quote.requestedDurationSec,
      billableDurationSec: quote.billableDurationSec,
      resolution: quote.effectiveResolution,
      aspectRatio: dto.aspectRatio ?? null,
      unitPriceCny: quote.unitPrice.toString(),
      markup: VIDEO_MARKUP.toString(),
      pricingRule: quote.pricingRule,
    }

    const source = dto.source ?? "video-project.generate"
    // 扣积分（与视频任务成功落库共用外层事务，保持原子；归属 active 企业走团队共享池）。
    // allowOverdraft：提交时已做余额预检，已出片的视频必须交付——结算允许小幅透支，绝不丢片。
    const consumeRes = await this.consumeRouted(tx, userId, quote.cost, {
      source,
      meta,
      allowOverdraft: true,
    })

    await tx.usageLog.create({
      data: {
        userId,
        type: UsageType.TOKEN,
        promptTokens: null,
        completionTokens: null,
        thinkingTokens: null,
        mcpCalls: null,
        inputCost: null,
        outputCost: null,
        cost: quote.cost,
        credits: consumeRes.creditsCharged,
        balanceAfter: consumeRes.balanceAfter,
        source,
        meta: meta,
      },
    })

    this.logger.log(
      `chargeVideo user=${userId} model=${dto.model} duration=${quote.billableDurationSec}s unit=${quote.unitPrice.toString()} costCny=${quote.cost.toString()} credits=${consumeRes.creditsCharged.toString()} balance=${consumeRes.balanceAfter.toString()}`
    )

    return {
      costCny: quote.cost,
      creditsCharged: consumeRes.creditsCharged,
      balance: consumeRes.balanceAfter,
      breakdown: consumeRes.breakdown,
    }
  }

  private quoteVideoCharge(dto: ChargeVideoParams): VideoChargeQuote {
    // 固定「每次生成」计价的模型（无时长维度）：成本价即整次费用，不乘时长
    const fixed = this.resolveFixedVideoPrice(dto)
    if (fixed) {
      const cost = fixed.price.mul(VIDEO_MARKUP)
      return {
        cost,
        unitPrice: cost,
        billableDurationSec: 0,
        requestedDurationSec: dto.durationSec,
        effectiveResolution: fixed.effectiveResolution,
        pricingRule: "video_fixed_per_generation_resolution_markup",
      }
    }

    const billableDurationSec = dto.durationSec > 0 ? dto.durationSec : VIDEO_AUTO_DURATION_BILL_SEC
    const base = this.resolveVideoUnitPrice(dto)
    // 用户实付单价 = 成本价 × 统一加价倍数
    const unitPrice = base.price.mul(VIDEO_MARKUP)
    return {
      cost: new Decimal(billableDurationSec).mul(unitPrice),
      unitPrice,
      billableDurationSec,
      requestedDurationSec: dto.durationSec,
      effectiveResolution: base.effectiveResolution,
      pricingRule: "video_cost_duration_resolution_markup",
    }
  }

  /**
   * 固定「每次生成」价模型的成本价（元/次，未加价）；非此类模型返回 null。
   * 目前：video-flash-reference（Gemini Omni 参考生视频，按分辨率固定价、与时长无关）。
   */
  private resolveFixedVideoPrice(
    dto: ChargeVideoParams
  ): { price: Decimal; effectiveResolution: string } | null {
    if (dto.model !== "video-flash-reference") return null
    const resolution = dto.resolution ?? "720p"
    const usd = VIDEO_FLASH_REF_USD_PER_GEN[resolution]
    if (!usd) throw new BadRequestException(`视频扣费不支持该分辨率: ${resolution}`)
    return { price: new Decimal(usd).mul(VEO_FX_CNY_PER_USD), effectiveResolution: resolution }
  }

  /** 返回各模型「成本价」（元/秒，未加价）；加价在 quoteVideoCharge 统一处理 */
  private resolveVideoUnitPrice(dto: ChargeVideoParams): {
    price: Decimal
    effectiveResolution: string | null
  } {
    if (dto.model === "video-lite") {
      // 全能参考档的 video-lite 是官方 Veo 3.1 Fast referenceImages，按 Veo 分辨率单价
      if (dto.mode === "REFERENCE") return this.veoFastUnitPrice(dto.resolution)
      return { price: VIDEO_LITE_COST_CNY, effectiveResolution: null }
    }

    if (dto.model === "video-flash") {
      return this.veoFastUnitPrice(dto.resolution)
    }

    if (dto.model === "video-turbo") {
      // Kling V3.0 Turbo 按秒计费，720p/1080p 同价；记录所选分辨率仅用于审计
      return {
        price: VIDEO_TURBO_USD_PER_SEC.mul(VEO_FX_CNY_PER_USD),
        effectiveResolution: dto.resolution ?? "1080p",
      }
    }

    if (dto.model === "video-edit") {
      // Kling O3 视频编辑按秒计费，无分辨率档（出片跟随源视频）
      return {
        price: VIDEO_EDIT_USD_PER_SEC.mul(VEO_FX_CNY_PER_USD),
        effectiveResolution: null,
      }
    }

    if (dto.model === "kling-motion") {
      const resolution = dto.resolution ?? "1080p"
      const usd = KLING_MOTION_USD_PER_SEC[resolution]
      if (!usd) throw new BadRequestException(`视频扣费不支持该分辨率: ${resolution}`)
      return { price: new Decimal(usd).mul(VEO_FX_CNY_PER_USD), effectiveResolution: resolution }
    }

    if (dto.model === "video-pro") {
      const resolution = dto.resolution ?? "720p"
      const price = VIDEO_PRO_COST_CNY[resolution]
      if (!price) throw new BadRequestException(`视频扣费不支持该分辨率: ${resolution}`)
      return { price: new Decimal(price), effectiveResolution: resolution }
    }

    if (dto.model === "video-mini") {
      const resolution = dto.resolution ?? "720p"
      const usd = SEEDANCE_MINI_USD_PER_SEC[resolution]
      if (!usd) throw new BadRequestException(`视频扣费不支持该分辨率: ${resolution}`)
      return { price: new Decimal(usd).mul(VEO_FX_CNY_PER_USD), effectiveResolution: resolution }
    }

    if (dto.model === "video-seedance-2-5") {
      return {
        price: SEEDANCE_25_USD_PER_SEC.mul(VEO_FX_CNY_PER_USD),
        effectiveResolution: dto.resolution ?? "720p",
      }
    }

    if (dto.model.startsWith("video-ultra")) {
      // Atlas Seedance 2.0 Fast 当前按秒同价；分辨率保留在审计信息中。
      return {
        price: ATLAS_SEEDANCE_FAST_USD_PER_SEC.mul(VEO_FX_CNY_PER_USD),
        effectiveResolution: dto.resolution ?? "720p",
      }
    }

    if (dto.model.startsWith("video-imagine")) {
      const table =
        dto.model === "video-imagine-1.5-preview"
          ? GROK_IMAGINE_15_USD_PER_SEC
          : GROK_IMAGINE_USD_PER_SEC
      const resolution = dto.resolution ?? "720p"
      const usd = table[resolution]
      if (!usd) throw new BadRequestException(`视频扣费不支持该分辨率: ${resolution}`)
      return { price: new Decimal(usd).mul(VEO_FX_CNY_PER_USD), effectiveResolution: resolution }
    }

    if (dto.model === "google_omni" || dto.model === "gork_imagine") {
      return { price: SUCHUANG_VIDEO_COST_CNY_PER_SEC, effectiveResolution: dto.resolution ?? null }
    }

    throw new BadRequestException(`视频扣费不支持该模型: ${dto.model}`)
  }

  /** 官方 Veo 3.1 Fast 成本价（美元/秒 × 汇率），video-flash 与 REFERENCE 档 video-lite 共用 */
  private veoFastUnitPrice(resolution?: string | null): {
    price: Decimal
    effectiveResolution: string
  } {
    const effective = resolution ?? "720p"
    const usd = VEO_FAST_USD_PER_SEC[effective]
    if (!usd) throw new BadRequestException(`视频扣费不支持该分辨率: ${effective}`)
    return { price: new Decimal(usd).mul(VEO_FX_CNY_PER_USD), effectiveResolution: effective }
  }
}
