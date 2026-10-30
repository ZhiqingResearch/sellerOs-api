import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import {
  CreditBucket,
  CreditLotStatus,
  CreditTxnType,
  InviteAppStatus,
  InviteApplication,
  Prisma,
  TeamStatus,
} from "@prisma/client"
import * as argon2 from "argon2"
import { PaginationDto } from "../common/dto/pagination.dto"
import { MailProvider } from "../common/providers/mail.provider"
import { DefaultMemberRoleService } from "../common/services/default-member-role.service"
import { beijingDayEnd, beijingDayStart } from "../common/utils/datetime"
import { quantize4 } from "../common/utils/decimal"
import { maskPhone } from "../common/utils/mask"
import { PrismaService } from "../prisma/prisma.service"
import { AdminDistService } from "./admin-dist.service"
import { CreditService } from "./credit.service"
import { QueryAdminApplicationsDto } from "./dto/admin-dist.dto"
import { InviteConfigDto, InviteRegisterDto, QueryInviteesDto } from "./dto/invite.dto"
import { QueryTransactionsDto } from "./dto/wallet.dto"
import {
  DEFAULT_LEVEL2_REBATE_RATE,
  INVITE_CODE_TTL_HOURS,
  SIGNUP_BONUS_CREDITS,
  resolveLevel,
  signupBonusExpiresAt,
} from "./membership.constants"
import { WalletService } from "./wallet.service"

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // 去掉易混字符
const CODE_TTL_MS = INVITE_CODE_TTL_HOURS * 60 * 60 * 1000
const EMAIL_CODE_TTL_MS = 5 * 60 * 1000
/** 邮箱验证码连续失败次数上限：达到即作废当前码（防在线爆破 6 位码） */
const EMAIL_CODE_MAX_ATTEMPTS = 5

@Injectable()
export class InviteService {
  private readonly logger = new Logger(InviteService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: CreditService,
    private readonly mail: MailProvider,
    private readonly wallet: WalletService,
    private readonly config: ConfigService,
    private readonly adminDist: AdminDistService,
    private readonly defaultMemberRole: DefaultMemberRoleService
  ) {}

  /** 系统初始密码：只来自环境变量 DEFAULT_USER_PASSWORD，未配置即报错（与 UserService 同源，不留兜底） */
  private get defaultPassword(): string {
    const pw = this.config.get<string>("DEFAULT_USER_PASSWORD")?.trim()
    if (!pw) {
      throw new InternalServerErrorException("系统未配置初始密码（环境变量 DEFAULT_USER_PASSWORD）")
    }
    return pw
  }

  // ==================== 邀请配置（后台） ====================

  /** 设置邀请配置：开/关邀请 + 折扣 + 返利比例 + 名额/二级返利/参与返利开关 + 下级可继续邀请。
   *  2026-08-20 新口径：邀请只是关系不是等级（LV4/LV5 取消）——开启不再清零套餐/撤订阅，邀请人可同时是 LV1-3 会员。
   *  2026-09-01 起落库制（废读时派生）：「下级可继续邀请」打开时**批量打开**一级下级邀请权+发邀请码（人工单独关过的跳过），
   *  关闭时（含关闭邀请连带）**批量收回**（清码+连带关返利+等级重算，不打人工标记——重开开关即恢复）；
   *  被邀请用户不可开「下级可继续邀请」（分销网络两级封顶，防三级裂变）。
   *  2026-09-23 恢复产品 §4.1 拦截（废 9-01「被邀请用户也可后台直开」）：一级分销代理只开给平台直签账号
   *  （invitedById 为空）；被邀请人的邀请权只能由其邀请人经「下级可继续邀请」开放——上级 canInvite+
   *  subInviteAllowed 双开关都在时放行（属二级范围内单独恢复，并清 canInviteManualOff 让上级批量打开能重新
   *  覆盖到；不放行则下级被单独关掉后永远开不回来），否则 400 引导先开上级开关。单人关闭不拦截（打人工标记）。 */
  async setInviteConfig(userId: number, dto: InviteConfigDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        canInvite: true,
        invitedById: true,
        subscriptionTier: true,
        inviteQuota: true,
        subInviteAllowed: true,
      },
    })
    if (!user) throw new NotFoundException("用户不存在")

    const data: Prisma.UserUpdateInput = {}
    if (dto.discount !== undefined) data.discount = dto.discount
    if (dto.rebateRate !== undefined) data.rebateRate = dto.rebateRate
    // 「邀请的用户共享我的额度」开关：与 canInvite 解耦，独立可改（仅 canRecharge 运营经此接口设置）
    if (dto.shareCredits !== undefined) data.shareCreditsWithInvitees = dto.shareCredits
    if (dto.inviteQuota !== undefined) data.inviteQuota = dto.inviteQuota
    if (dto.subInviteAllowed !== undefined) data.subInviteAllowed = dto.subInviteAllowed
    if (dto.rebateEnabled !== undefined) data.rebateEnabled = dto.rebateEnabled
    if (dto.level2RebateRate !== undefined) data.level2RebateRate = dto.level2RebateRate

    // 名额边界（2026-09-02 bug29）：显式设置名额时仅当「上限 < 已建号人数」才拒绝保存；
    // 上限=已用是合法配置（邀请码/新增入口按名额已满拦截，存量关系不受影响）
    if (dto.inviteQuota != null) {
      const used = await this.prisma.user.count({ where: { invitedById: userId } })
      if (dto.inviteQuota < used) {
        throw new BadRequestException(`邀请名额上限不能小于当前已用人数（当前已用 ${used} 人）`)
      }
    }

    // 被邀请人开邀请权守卫（2026-09-23 恢复 §4.1 拦截，废 9-01 放开）：一级分销代理只开给平台直签账号；
    // 被邀请人的邀请权只能由其邀请人经「下级可继续邀请」开放。上级 canInvite+subInviteAllowed 双开关都在时
    // 放行（属二级范围内单独恢复，开启分支会清 canInviteManualOff），否则 400 引导先开上级开关。
    // 只拦「关 → 开」：已开着的存量行重复提交 canInvite=true 是幂等不改数据，不拦（否则存量行无法保存其它配置）
    if (dto.canInvite === true && !user.canInvite && user.invitedById != null) {
      const inviter = await this.prisma.user.findUnique({
        where: { id: user.invitedById },
        select: { username: true, canInvite: true, subInviteAllowed: true },
      })
      if (!inviter?.canInvite || !inviter.subInviteAllowed) {
        const name = inviter?.username ?? `用户#${user.invitedById}`
        throw new BadRequestException(
          `该用户由 ${name} 邀请注册，不能开一级分销代理；如需让他继续邀请下级，请在【客户运营·分销管理】里对 ${name} 开启「下级可继续邀请」。`
        )
      }
    }

    await this.prisma.$transaction(async tx => {
      // 「下级可继续邀请」守卫（2026-09-01 落库制）：被邀请用户不可开（网络两级封顶）；本人无邀请权不可开
      if (dto.subInviteAllowed === true) {
        if (user.invitedById != null) {
          throw new BadRequestException("被邀请用户不可开启「下级可继续邀请」（分销网络最多两级）")
        }
        if (!(dto.canInvite ?? user.canInvite)) {
          throw new BadRequestException(
            "请先开启该用户的「允许邀请注册」，再开启「下级可继续邀请」"
          )
        }
      }
      if (dto.canInvite === true && !user.canInvite) {
        // 开启邀请：发放邀请码（7 天）。套餐/赠送/充值积分一律不动。
        // 被邀请人走到这已通过上方守卫（上级双开关都在），单人开通即清人工关闭标记
        // （恢复参与上级批量打开）。名额边界（2026-09-02 bug29）：名额=已用时**允许保存**——
        // 邀请码照发，新增邀请由 verify/register 入口按「名额已用完」拦截，已有关系不受影响
        data.canInvite = true
        data.canInviteManualOff = false
        // 重开同步恢复「参与返利计划」（2026-09-03 bug31：撤销关闭时的连带关返利，
        // 避免用户管理页单开关重开后「可邀请但未参与返利」的不一致状态。
        // 注意与额度共享不同口径：shareCreditsWithInvitees 重开不自动恢复，需邀请人重新配置）
        data.rebateEnabled = true
        data.inviteCode = await this.generateUniqueCode(tx)
        data.inviteCodeExpiresAt = new Date(Date.now() + CODE_TTL_MS)
      } else if (dto.canInvite === false && user.canInvite) {
        // 关闭邀请：清邀请码；等级按订阅重算（历史 INVITER 行回到订阅档/NONE）。
        // 同步收回「下级可继续邀请」（原型同口径：没邀请权就不存在二级设置）——其下级在下方级联批量收回。
        // 连带关闭「参与返利计划」（2026-08-31，原型关闭确认弹窗「参与返利计划一并关闭，返利收益停止累积」）；
        // 重开邀请同步恢复 rebateEnabled（2026-09-03 bug31，废 8-31「手动重开」口径）。
        data.canInvite = false
        data.inviteCode = null
        data.inviteCodeExpiresAt = null
        data.subInviteAllowed = false
        data.rebateEnabled = false
        // 连带关闭「邀请的用户共享我的额度」（2026-09-02 bug28：关闭邀请即收回额度授权）；
        // 重开邀请不自动恢复——邀请人需重新主动配置
        data.shareCreditsWithInvitees = false
        data.membershipLevel = resolveLevel({ subscriptionTier: user.subscriptionTier })
        // 被邀请用户被人工单独关闭 → 打标记：上级批量打开时跳过、保持关闭（2026-09-01 产品口径）
        if (user.invitedById != null) data.canInviteManualOff = true
      }
      await tx.user.update({ where: { id: userId }, data })

      // 「下级可继续邀请」批量落库（2026-09-01 起，废读时派生——下级的邀请权就是本人 canInvite 落库值）
      if (dto.subInviteAllowed === true) {
        // 开：批量打开一级下级邀请权 + 发邀请码（人工单独关过的跳过、保持关闭；已打开的幂等跳过）；
        // 连带恢复返利参与（2026-09-03 bug31 同口径：批量收回时连带关的返利随批量打开一并撤销）
        const kids = await tx.user.findMany({
          where: { invitedById: userId, canInvite: false, canInviteManualOff: false },
          select: { id: true },
        })
        for (const k of kids) {
          await tx.user.update({
            where: { id: k.id },
            data: {
              canInvite: true,
              rebateEnabled: true,
              inviteCode: await this.generateUniqueCode(tx),
              inviteCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
            },
          })
        }
      }
      // 关：显式关开关，或关闭邀请连带（其「下级可继续邀请」被收回）→ 批量收回一级下级
      if (dto.subInviteAllowed === false || (dto.canInvite === false && user.subInviteAllowed)) {
        // 批量收回：清码 + 连带关返利 + 等级按订阅重算（与单人关闭同口径）；
        // 不打人工关闭标记（canInviteManualOff=false）——上级重开开关即恢复
        const kids = await tx.user.findMany({
          where: { invitedById: userId, canInvite: true },
          select: { id: true, subscriptionTier: true },
        })
        for (const k of kids) {
          await tx.user.update({
            where: { id: k.id },
            data: {
              canInvite: false,
              inviteCode: null,
              inviteCodeExpiresAt: null,
              rebateEnabled: false,
              // 批量收回同口径连带关闭额度共享（bug28）：下级不得再消耗其积分；上级重开即恢复邀请权但共享需重新配置
              shareCreditsWithInvitees: false,
              canInviteManualOff: false,
              membershipLevel: resolveLevel({ subscriptionTier: k.subscriptionTier }),
            },
          })
        }
      }

      // 「下级进企业后仍计返利」逐人开关（2026-08-31，原型邀请配置弹窗逐人列表）：
      // 每个目标必须是我的直接下级且当前是占用中企业管理员；写其 User.corpPassUp（逐人设定优先于全局 corpCounts）
      if (dto.corpPassUpToggles?.length) {
        const ids = dto.corpPassUpToggles.map(t => t.userId)
        const kids = await tx.user.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            username: true,
            invitedById: true,
            teamMemberships: {
              where: { role: "ADMIN", status: { in: ["ACTIVE", "DISABLED"] } },
              select: { team: { select: { status: true } } },
            },
          },
        })
        const byId = new Map(kids.map(k => [k.id, k]))
        for (const t of dto.corpPassUpToggles) {
          const kid = byId.get(t.userId)
          const isOccupyingAdmin = kid?.teamMemberships.some(
            m => m.team.status === "ACTIVE" || m.team.status === "GRACE"
          )
          if (!kid || kid.invitedById !== userId || !isOccupyingAdmin) {
            throw new BadRequestException(
              `「${kid?.username ?? t.userId}」不是你的直接下级或已不是企业管理员，无法设置该项`
            )
          }
        }
        for (const t of dto.corpPassUpToggles) {
          await tx.user.update({ where: { id: t.userId }, data: { corpPassUp: t.enabled } })
        }
      }
    })
    this.logger.log(`setInviteConfig user=${userId} canInvite=${dto.canInvite}`)
    return this.getInviteOverview(userId)
  }

  // ==================== 邀请码 / 我的邀请（邀请人） ====================

  /** 我的邀请：邀请码（7 天，过期惰性重生）、名额/二级邀请开关、返利汇总、二级网络统计、待审批申请。
   *  networkStats（2026-09-01 复修）：消耗=成员个人段 + 网络管理员企业全队池段（与关系树/列表卷起同口径）；
   *  剩余=个人剩余（剔除池批次）+ 企业池剩余（按 teamId）；待结算返利按「个人剩余 + 计返利池剩余」分层×比例，
   *  池段计返利闸门 = corpPassUp ?? 全局 corpCounts ?? true（不计返利的池剩余 corpPoolRemainingExcluded 透出）。 */
  async getMyInvite(userId: number) {
    const user = await this.requireInviter(userId)
    const code = await this.ensureFreshCode(user)
    const [rebate, pending, inviteQuotaUsed, level1Rows, level2Rows] = await Promise.all([
      this.getRebateSummary(userId),
      this.prisma.inviteApplication.findMany({
        where: { inviterId: userId, status: InviteAppStatus.PENDING },
        orderBy: { createdAt: "desc" },
        select: { id: true, username: true, email: true, phone: true, createdAt: true },
      }),
      // 已用名额 = 实际建号的直接下级数（含手机号自助注册）
      this.prisma.user.count({ where: { invitedById: userId } }),
      // 占用中企业管理员身份（2026-09-01 统计卡复修：其企业池消耗/剩余卷起挂到该下级所在层，
      // 与关系树/我邀请的用户列表同口径；批次带 userId=管理员，必须按 teamId 查池、个人侧剔除 teamId 行防双计）
      this.prisma.user.findMany({
        where: { invitedById: userId },
        select: {
          id: true,
          corpPassUp: true,
          teamMemberships: {
            where: { role: "ADMIN", status: { in: ["ACTIVE", "DISABLED"] } },
            select: { teamId: true, team: { select: { status: true } } },
          },
        },
      }),
      this.prisma.user.findMany({
        where: { invitedBy: { invitedById: userId } },
        select: {
          id: true,
          corpPassUp: true,
          teamMemberships: {
            where: { role: "ADMIN", status: { in: ["ACTIVE", "DISABLED"] } },
            select: { teamId: true, team: { select: { status: true } } },
          },
        },
      }),
    ])
    const level1Ids = level1Rows.map(u => u.id)
    const level2Ids = level2Rows.map(u => u.id)
    const networkIds = [...level1Ids, ...level2Ids]
    // 各层的占用中企业（ACTIVE/GRACE）管理员 → teamId + 池段是否计返利（corpPassUp ?? 全局 corpCounts ?? true）
    const occupyingAdminTeams = (rows: typeof level1Rows) =>
      rows.flatMap(u =>
        u.teamMemberships
          .filter(m => m.team.status === TeamStatus.ACTIVE || m.team.status === TeamStatus.GRACE)
          .map(m => ({ teamId: m.teamId, corpPassUp: u.corpPassUp }))
      )
    const l1AdminTeams = occupyingAdminTeams(level1Rows)
    const l2AdminTeams = occupyingAdminTeams(level2Rows)
    const adminTeamIds = [...l1AdminTeams, ...l2AdminTeams].map(t => t.teamId)

    // 统计卡聚合：消耗合计 + 分层剩余可消耗（与钱包可消费余额同口径：ACTIVE 未过期 RECHARGE+PACKAGE+GIFT）
    const now = new Date()
    const consumableScope = {
      bucket: { in: [CreditBucket.RECHARGE, CreditBucket.PACKAGE, CreditBucket.GIFT] },
      status: CreditLotStatus.ACTIVE,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    }
    const [
      consumedPersonalAgg,
      consumedPoolAgg,
      l1RemainAgg,
      l2RemainAgg,
      poolRemainGroups,
      rebateRule,
    ] = await Promise.all([
      // 个人段：网络成员自己户头的消耗（teamId 空；池段行统一走下方 teamId 口径，两段互斥不双计）
      networkIds.length
        ? this.prisma.creditTransaction.aggregate({
            where: {
              userId: { in: networkIds },
              teamId: null,
              type: { in: [CreditTxnType.CONSUME, CreditTxnType.TEAM_CONSUME] },
            },
            _sum: { amount: true },
          })
        : null,
      // 池段：网络管理员所在企业的全队池消耗（含普通成员池消耗，与关系树管理员节点卷起同口径）
      adminTeamIds.length
        ? this.prisma.creditTransaction.aggregate({
            where: {
              teamId: { in: adminTeamIds },
              type: { in: [CreditTxnType.CONSUME, CreditTxnType.TEAM_CONSUME] },
            },
            _sum: { amount: true },
          })
        : null,
      // 个人剩余：剔除 teamId 批次（企业池批次带 userId=管理员，不剔会把池算进个人）
      level1Ids.length
        ? this.prisma.creditLot.aggregate({
            where: { userId: { in: level1Ids }, teamId: null, ...consumableScope },
            _sum: { remaining: true },
          })
        : null,
      level2Ids.length
        ? this.prisma.creditLot.aggregate({
            where: { userId: { in: level2Ids }, teamId: null, ...consumableScope },
            _sum: { remaining: true },
          })
        : null,
      // 企业池剩余：按 teamId 分组（不依赖批次上的 userId 是不是管理员本人）
      adminTeamIds.length
        ? this.prisma.creditLot.groupBy({
            by: ["teamId"],
            where: { teamId: { in: adminTeamIds }, ...consumableScope },
            _sum: { remaining: true },
          })
        : [],
      adminTeamIds.length
        ? this.prisma.rebateRule.findFirst({
            orderBy: { id: "asc" },
            select: { corpCounts: true },
          })
        : null,
    ])
    const consumed = new Prisma.Decimal(consumedPersonalAgg?._sum?.amount ?? 0).plus(
      consumedPoolAgg?._sum?.amount ?? 0
    )
    const poolRemainByTeam = new Map(
      poolRemainGroups.map(g => [g.teamId, new Prisma.Decimal(g._sum?.remaining ?? 0)])
    )
    // 池段计返利闸门（与结算内核 consumeTeamCredits 同口径）：逐人 corpPassUp ?? 全局 corpCounts ?? true
    const sumPool = (
      teams: { teamId: number; corpPassUp: boolean | null }[],
      billableOnly: boolean
    ) =>
      teams
        .filter(t => !billableOnly || (t.corpPassUp ?? rebateRule?.corpCounts ?? true))
        .reduce(
          (s, t) => s.plus(poolRemainByTeam.get(t.teamId) ?? new Prisma.Decimal(0)),
          new Prisma.Decimal(0)
        )
    const l1Personal = new Prisma.Decimal(l1RemainAgg?._sum?.remaining ?? 0)
    const l2Personal = new Prisma.Decimal(l2RemainAgg?._sum?.remaining ?? 0)
    const l1Pool = sumPool(l1AdminTeams, false)
    const l2Pool = sumPool(l2AdminTeams, false)
    const l1PoolBillable = sumPool(l1AdminTeams, true)
    const l2PoolBillable = sumPool(l2AdminTeams, true)
    const remainingTotal = l1Personal.plus(l2Personal).plus(l1Pool).plus(l2Pool)
    // 待结算返利：分层（个人剩余 + 计返利企业池剩余）× 对应层比例（4dp 不抹零，与结算内核同口径）；
    // 池段不计返利（corpPassUp/corpCounts 关）的企业池剩余不进预估（corpPoolRemainingExcluded 单独透出）。
    // 预估不模拟计酬闸门逐层校验与月/单笔封顶——实际以结算内核为准。
    const rate1 = new Prisma.Decimal(user.rebateRate ?? "0.3")
    const rate2 = new Prisma.Decimal(user.level2RebateRate ?? DEFAULT_LEVEL2_REBATE_RATE)
    const pendingRebate = quantize4(l1Personal.plus(l1PoolBillable).mul(rate1)).plus(
      quantize4(l2Personal.plus(l2PoolBillable).mul(rate2))
    )

    return {
      inviteCode: code.inviteCode,
      inviteCodeExpiresAt: code.inviteCodeExpiresAt,
      inviteQuota: user.inviteQuota,
      inviteQuotaUsed,
      subInviteAllowed: user.subInviteAllowed,
      rebate,
      network: { level1Count: level1Ids.length, level2Count: level2Ids.length },
      networkStats: {
        consumedTotal: consumed.toString(), // 团队消耗积分（网络累计：成员个人消耗 + 网络管理员企业全队池消耗）
        remainingTotal: remainingTotal.toString(), // 团队总额度·当前剩余（个人剩余 + 企业池剩余）
        rechargedTotal: consumed.plus(remainingTotal).toString(), // 团队总额度 = 消耗+剩余（下级手中曾有/现有总量，含企业池）
        rebateRate: rate1.toString(), // 一级返利比例（卡片「（50%）」改用此值渲染，勿再单一标注）
        // 二级返利比例（含默认 0.10）：2026-09-02 bug23 起被邀请人视角不下发——该比例是
        // 「其下级消费时返给其上级」的上游配置，且被邀请人两级封顶不可能有二级下线，与本人收益无关
        level2RebateRate: user.invitedById == null ? rate2.toString() : null,
        pendingRebate: pendingRebate.toString(), // 尚有 X 积分待下级消耗后到账（分层比例预估）
        estimatedRebate: new Prisma.Decimal(rebate.earned).plus(pendingRebate).toString(), // 预计可获得返利
        corpPoolRemainingExcluded: l1Pool
          .plus(l2Pool)
          .minus(l1PoolBillable)
          .minus(l2PoolBillable)
          .toString(), // 企业池不计返利而未纳入预估的池剩余合计
      },
      pendingApplications: pending,
    }
  }

  /**
   * C 端邀请团队关系树（产品 §7.2.3）：登录用户查自己，响应结构与后台 GET /admin/dist/tree 完全一致
   * （复用同一 loadTree 聚合），仅鉴权不同——要求本人已开通邀请权限（requireInviter 403）。
   */
  async getMyTree(userId: number, query: PaginationDto) {
    await this.requireInviter(userId)
    return this.adminDist.getTree({ userId, page: query.page, pageSize: query.pageSize })
  }

  /**
   * 我邀请的用户列表（被邀请人，分页）。返回：用户名/手机号/角色/总额度/已消耗/剩余/账户状态/贡献返利。
   * 口径：剩余 = 其自己可消费余额；已消耗 = 本人个人消费 + 动用我（邀请人）额度的消耗 +
   * （占用中企业管理员下级）其企业全队池消耗 /（普通下级）本人池消耗（2026-09-01 bug9 复修，
   * 与该下级「使用记录」可见口径一致：管理员视角=本人行∪本企业池行）；贡献返利 = 个人段 + 池段
   * （池段按 REBATE_IN.teamId 卷起，存量行需 backfill-rebate-team-id 回填）；总额度 = 已消耗 + 剩余。
   * 搜索（用户名/手机号）、按角色筛、注册时间范围（startDate/endDate，北京自然日整天，2026-08-31 补）、
   * 可排序（默认已消耗倒序）。财务列需全量计算后排序分页，故先取全量再内存分页。
   */
  async listInvitees(userId: number, query: QueryInviteesDto) {
    const me = await this.requireInviter(userId)
    const { page, pageSize, keyword, role, startDate, endDate } = query
    const sortBy = query.sortBy ?? "consumed"
    const sortDir = query.sortDir ?? "desc"

    const where: Prisma.UserWhereInput = { invitedById: userId }
    if (keyword) {
      where.OR = [{ username: { contains: keyword } }, { phone: { contains: keyword } }]
    }
    if (role) where.roles = { some: { role: { code: role } } }
    if (startDate || endDate) {
      // 注册时间范围：北京自然日整天（startDate 00:00:00.000 ~ endDate 23:59:59.999，含边界日）
      const gte = startDate ? beijingDayStart(startDate) : null
      const lte = endDate ? beijingDayEnd(endDate) : null
      if ((startDate && !gte) || (endDate && !lte)) {
        throw new BadRequestException("注册日期不合法")
      }
      if (gte && lte && gte.getTime() > lte.getTime()) {
        throw new BadRequestException("注册开始日期不能晚于结束日期")
      }
      where.createdAt = { ...(gte && { gte }), ...(lte && { lte }) }
    }

    const users = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        username: true,
        phone: true,
        membershipLevel: true,
        discount: true,
        isActive: true,
        createdAt: true,
        roles: { select: { role: { select: { code: true, name: true, color: true } } } },
        // 占用中企业管理员身份（2026-09-01 bug9 复修：池消耗/池返利卷起挂到管理员下级行）
        teamMemberships: {
          where: { role: "ADMIN", status: { in: ["ACTIVE", "DISABLED"] } },
          select: { teamId: true, team: { select: { status: true } } },
        },
      },
    })

    const ids = users.map(u => u.id)
    // 下级中的占用中企业管理员 → 其企业 id（池卷起用）
    const adminTeamIdOf = new Map<number, number>()
    for (const u of users) {
      const m = u.teamMemberships.find(
        mm => mm.team.status === TeamStatus.ACTIVE || mm.team.status === TeamStatus.GRACE
      )
      if (m) adminTeamIdOf.set(u.id, m.teamId)
    }
    const adminTeamIds = [...new Set(adminTeamIdOf.values())]
    const now = new Date()
    const zero = () => new Prisma.Decimal(0)
    const [lotRows, ownRows, sharedRows, rebateRows, roleRows, poolConsumeRows, poolRebateRows] =
      await Promise.all([
        ids.length
          ? this.prisma.creditLot.groupBy({
              by: ["userId"],
              where: {
                userId: { in: ids },
                bucket: { in: [CreditBucket.RECHARGE, CreditBucket.PACKAGE, CreditBucket.GIFT] },
                status: CreditLotStatus.ACTIVE,
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
              },
              _sum: { remaining: true },
            })
          : [],
        ids.length
          ? this.prisma.creditTransaction.groupBy({
              by: ["userId", "type"],
              // 本人消耗按类型拆开：个人 CONSUME 与本人企业池 TEAM_CONSUME——
              // 企业管理员下级的池消耗由下方「全队聚合」卷起（含本人池行），这里要拆开防双计
              where: {
                userId: { in: ids },
                type: { in: [CreditTxnType.CONSUME, CreditTxnType.TEAM_CONSUME] },
              },
              _sum: { amount: true },
            })
          : [],
        // 动用我额度的消耗：记在我（邀请人）账上、relatedUserId=被邀请人 的 CONSUME 流水
        ids.length
          ? this.prisma.creditTransaction.groupBy({
              by: ["relatedUserId"],
              where: { userId, type: CreditTxnType.CONSUME, relatedUserId: { in: ids } },
              _sum: { amount: true },
            })
          : [],
        // 各被邀请人为我贡献的累计返利（REBATE_IN.relatedUserId = 被邀请人；个人段）
        ids.length
          ? this.prisma.creditTransaction.groupBy({
              by: ["relatedUserId"],
              where: { userId, type: CreditTxnType.REBATE_IN, relatedUserId: { in: ids } },
              _sum: { amount: true },
            })
          : [],
        // 全量角色选项（跨页去重，供筛选下拉——当前页独有的角色也能筛到）
        this.prisma.userRole.findMany({
          where: { user: { invitedById: userId } },
          select: { role: { select: { code: true, name: true, color: true } } },
          distinct: ["roleId"],
        }),
        // 企业管理员下级的本企业全队池消耗（含其本人池行；成员可能不是我的下级，本人口径盖不住）
        adminTeamIds.length
          ? this.prisma.creditTransaction.groupBy({
              by: ["teamId"],
              where: { teamId: { in: adminTeamIds }, type: CreditTxnType.TEAM_CONSUME },
              _sum: { amount: true },
            })
          : [],
        // 池段为我贡献的累计返利（REBATE_IN 落 teamId，2026-09-01 起；
        // 存量池返利行 teamId=null 不参与——跑 scripts/backfill-rebate-team-id.ts 回填）
        adminTeamIds.length
          ? this.prisma.creditTransaction.groupBy({
              by: ["teamId"],
              where: { userId, type: CreditTxnType.REBATE_IN, teamId: { in: adminTeamIds } },
              _sum: { amount: true },
            })
          : [],
      ])

    const remainingBy = new Map<number, Prisma.Decimal>()
    for (const r of lotRows) remainingBy.set(r.userId, r._sum.remaining ?? zero())
    const ownPersonalBy = new Map<number, Prisma.Decimal>()
    const ownTeamBy = new Map<number, Prisma.Decimal>()
    for (const r of ownRows) {
      const target = r.type === CreditTxnType.TEAM_CONSUME ? ownTeamBy : ownPersonalBy
      target.set(r.userId, (target.get(r.userId) ?? zero()).plus(r._sum.amount ?? zero()))
    }
    const sharedConsumedBy = new Map<number, Prisma.Decimal>()
    for (const r of sharedRows) {
      if (r.relatedUserId != null) sharedConsumedBy.set(r.relatedUserId, r._sum.amount ?? zero())
    }
    const rebateBy = new Map<number, Prisma.Decimal>()
    for (const r of rebateRows) {
      if (r.relatedUserId != null) rebateBy.set(r.relatedUserId, r._sum.amount ?? zero())
    }
    const poolConsumeByTeam = new Map<number, Prisma.Decimal>()
    for (const r of poolConsumeRows) {
      if (r.teamId != null) poolConsumeByTeam.set(r.teamId, r._sum.amount ?? zero())
    }
    const poolRebateByTeam = new Map<number, Prisma.Decimal>()
    for (const r of poolRebateRows) {
      if (r.teamId != null) poolRebateByTeam.set(r.teamId, r._sum.amount ?? zero())
    }

    const items = users.map(u => {
      const remaining = remainingBy.get(u.id) ?? zero()
      const adTid = adminTeamIdOf.get(u.id) ?? null
      // 已消耗 = 个人消费 + 动用我额度 + （企业管理员下级）其企业全队池消耗（含其本人池行）
      // /（普通下级）本人池消耗——与「使用记录」可见口径一致（管理员视角=本人行∪本企业池行）
      const consumed = (ownPersonalBy.get(u.id) ?? zero())
        .plus(sharedConsumedBy.get(u.id) ?? zero())
        .plus(
          adTid != null ? (poolConsumeByTeam.get(adTid) ?? zero()) : (ownTeamBy.get(u.id) ?? zero())
        )
      // 贡献返利 = 个人段（relatedUserId=本人）+（企业管理员下级）本企业池段（REBATE_IN 落 teamId）
      const rebateContributed = (rebateBy.get(u.id) ?? zero()).plus(
        adTid != null ? (poolRebateByTeam.get(adTid) ?? zero()) : zero()
      )
      return {
        id: u.id,
        username: u.username,
        phone: maskPhone(u.phone), // 下级手机号默认脱敏（2026-08-31 起，与后台各列表同口径）
        level: u.membershipLevel,
        isActive: u.isActive,
        discount: u.discount.toString(),
        createdAt: u.createdAt,
        roles: u.roles.map(r => ({
          code: r.role.code,
          name: r.role.name,
          color: r.role.color ?? null,
        })),
        total: consumed.plus(remaining).toString(), // 总额度 = 已消耗 + 剩余
        consumed: consumed.toString(), // 已消耗口径见上
        remaining: remaining.toString(), // 剩余 = 自己可消费余额
        rebateContributed: rebateContributed.toString(),
      }
    })

    const dir = sortDir === "asc" ? 1 : -1
    items.sort((a, b) => {
      if (sortBy === "createdAt") {
        return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      }
      const av = sortBy === "remaining" ? a.remaining : sortBy === "total" ? a.total : a.consumed
      const bv = sortBy === "remaining" ? b.remaining : sortBy === "total" ? b.total : b.consumed
      return dir * new Prisma.Decimal(av).comparedTo(new Prisma.Decimal(bv))
    })

    const total = items.length
    const start = (page - 1) * pageSize
    return {
      items: items.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      // 我是否开启「共享额度」——前端据此决定是否显示「+可用邀请人额度」文案（不返回邀请人额度数值）
      canShareFromInviter: me.shareCreditsWithInvitees,
      // 全量角色选项（跨页去重）：角色筛选下拉数据源，第 N 页独有的角色也能筛
      roleOptions: roleRows.map(r => ({
        code: r.role.code,
        name: r.role.name,
        color: r.role.color ?? null,
      })),
    }
  }

  /** 邀请人停用 / 启用其下级账号。仅能操作自己邀请的用户，否则 403。 */
  async setInviteeStatus(inviterId: number, inviteeId: number, isActive: boolean) {
    await this.requireInviter(inviterId)
    const invitee = await this.prisma.user.findUnique({
      where: { id: inviteeId },
      select: { id: true, invitedById: true },
    })
    if (!invitee || invitee.invitedById !== inviterId) {
      throw new ForbiddenException("只能停用 / 启用自己邀请的用户")
    }
    await this.prisma.user.update({
      where: { id: inviteeId },
      // deactivatedAt 与用户管理 setStatus 同口径；停用后 JwtStrategy 即时拦截其令牌
      data: { isActive, deactivatedAt: isActive ? null : new Date() },
    })
    this.logger.log(
      `setInviteeStatus inviter=${inviterId} invitee=${inviteeId} isActive=${isActive}`
    )
    return { id: inviteeId, isActive }
  }

  /**
   * 邀请人重置某下级密码为系统默认密码：仅限自己邀请的用户（否则 403）。
   * 置默认密码 + 标记首次登录强制改密，不返回明文、不发短信（默认密码由邀请人线下告知下级）。
   */
  async resetInviteePassword(inviterId: number, inviteeId: number) {
    await this.requireInviter(inviterId)
    const invitee = await this.prisma.user.findUnique({
      where: { id: inviteeId },
      select: { id: true, invitedById: true },
    })
    if (!invitee || invitee.invitedById !== inviterId) {
      throw new ForbiddenException("只能重置自己邀请的用户的密码")
    }
    const password = await argon2.hash(this.defaultPassword)
    await this.prisma.user.update({
      where: { id: inviteeId },
      data: { password, mustChangePassword: true },
    })
    this.logger.log(`resetInviteePassword inviter=${inviterId} invitee=${inviteeId}`)
    return { id: inviteeId }
  }

  /** 邀请人查看某下级的积分流水（充值/使用，分页）；仅限查询自己邀请的用户，否则 403。 */
  async listInviteeTransactions(inviterId: number, inviteeId: number, query: QueryTransactionsDto) {
    await this.requireInviter(inviterId)
    const invitee = await this.prisma.user.findUnique({
      where: { id: inviteeId },
      select: { invitedById: true },
    })
    if (!invitee || invitee.invitedById !== inviterId) {
      throw new ForbiddenException("只能查看自己邀请的用户的流水")
    }
    return this.wallet.listTransactions(inviteeId, query)
  }

  /**
   * 手动刷新邀请码（旧码立即失效）。
   * 并发安全（2026-08-31）：条件更新占位——仅当库中邀请码仍是自己读到的旧值时才写入新码；
   * 被并发请求抢先则重读库中最新码直接返回，保证**所有成功响应的码 = 最终有效码**
   * （旧语义是无条件覆盖写：两个并发刷新各回各的码，后提交者覆盖，先响应的码立即失效）。
   */
  async refreshCode(userId: number) {
    await this.requireInviter(userId)
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { inviteCode: true, inviteCodeExpiresAt: true },
      })
      if (!cur) throw new NotFoundException("用户不存在")
      const inviteCode = await this.generateUniqueCode()
      const inviteCodeExpiresAt = new Date(Date.now() + CODE_TTL_MS)
      const r = await this.prisma.user.updateMany({
        where: { id: userId, inviteCode: cur.inviteCode }, // 占位条件：旧值未变才落新码
        data: { inviteCode, inviteCodeExpiresAt },
      })
      if (r.count > 0) return { inviteCode, inviteCodeExpiresAt }
      // 并发被抢先：重读最新码，仍有效则直接返回（两端拿到同一个最终有效码）；失效则下轮重试
      const latest = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { inviteCode: true, inviteCodeExpiresAt: true },
      })
      if (
        latest?.inviteCode &&
        latest.inviteCodeExpiresAt &&
        latest.inviteCodeExpiresAt > new Date()
      ) {
        return { inviteCode: latest.inviteCode, inviteCodeExpiresAt: latest.inviteCodeExpiresAt }
      }
    }
    throw new ConflictException("邀请码刷新冲突，请重试")
  }

  // ==================== 注册（公开） ====================

  /** 校验邀请码有效性（7 天）。无效/过期 → 400「无效链接」。 */
  async verifyInviteCode(code: string) {
    const inviter = await this.findValidInviter(code)
    return { valid: true, inviterId: inviter.id, inviterName: inviter.username }
  }

  /** 自助注册与旧审批锁同一邀请人行，名额和邀请配置在锁内重新校验；不复制组织。 */
  async registrationInviteData(tx: Prisma.TransactionClient, code: string) {
    await tx.$queryRaw`SELECT id FROM \`User\` WHERE inviteCode = ${code} FOR UPDATE`
    const inviter = await this.findValidInviter(code, tx)
    return {
      invitedById: inviter.id,
      discount: inviter.discount,
      ...(inviter.subInviteAllowed
        ? {
            canInvite: true,
            inviteCode: await this.generateUniqueCode(tx),
            inviteCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
          }
        : {}),
    }
  }

  /** 发送邮箱注册验证码（60s 限频）。重发即作废旧码：同一邮箱仅最新一条验证码可用。 */
  async sendEmailCode(email: string) {
    const recent = await this.prisma.emailCode.findFirst({
      where: { email },
      orderBy: { createdAt: "desc" },
    })
    if (recent && Date.now() - recent.createdAt.getTime() < 60 * 1000) {
      throw new BadRequestException("验证码获取过于频繁，请 60 秒后再试")
    }
    const code = Math.floor(Math.random() * 1000000)
      .toString()
      .padStart(6, "0")
    await this.prisma.$transaction([
      // 作废旧码：未使用的历史验证码全部置 used，仅新码可核销（防新旧码并存混用）
      this.prisma.emailCode.updateMany({ where: { email, used: false }, data: { used: true } }),
      this.prisma.emailCode.create({
        data: { email, code, expiredAt: new Date(Date.now() + EMAIL_CODE_TTL_MS) },
      }),
    ])
    // 异步发送，不阻塞响应：验证码已落库，SMTP 慢/超时不拖住前端；失败仅记录（用户可 60s 后重试）
    void this.mail.sendVerificationCode(email, code).catch((err: unknown) => {
      this.logger.error(
        `发送邮箱验证码失败 email=${email}: ${err instanceof Error ? err.message : String(err)}`
      )
    })
    return { sent: true }
  }

  /** 邀请注册：校验邀请码 + 资料唯一性 + 邮箱验证码 → 建 PENDING 申请，待邀请人审核。
   *  顺序（2026-08-31）：先做**可恢复的资料校验**（手机号已注册/待审占用/重复申请），
   *  全部通过后才核销邮箱验证码——校验失败不烧码，用户修正资料后可用原码重试；
   *  验证码核销（原子占位）与建库相邻，并发下同码仍只会成功一次。 */
  async register(dto: InviteRegisterDto) {
    const inviter = await this.findValidInviter(dto.inviteCode)

    // phone 是审核通过后的登录账号，必须全局唯一：已是正式账号则拒绝
    const phoneTaken = await this.prisma.user.findUnique({ where: { phone: dto.phone } })
    if (phoneTaken) throw new ConflictException("该手机号已注册")

    // 同一手机号已有待审申请（不分邀请人）也拒绝，避免两份申请抢占同一登录账号、到审批才晚失败
    const phonePending = await this.prisma.inviteApplication.findFirst({
      where: { phone: dto.phone, status: InviteAppStatus.PENDING },
    })
    if (phonePending) throw new ConflictException("该手机号已提交注册申请，待审核，请勿重复提交")

    const pendingDup = await this.prisma.inviteApplication.findFirst({
      where: { inviterId: inviter.id, email: dto.email, status: InviteAppStatus.PENDING },
    })
    if (pendingDup) throw new ConflictException("已提交申请，请等待邀请人审核")

    const okCode = await this.consumeEmailCode(dto.email, dto.emailCode)
    if (!okCode) throw new BadRequestException("邮箱验证码错误或已过期")

    const passwordHash = await argon2.hash(dto.password)
    // pendingPhone=phone：DB 唯一约束兜底并发——同号第二份待审申请 insert 会撞 P2002（上面 findFirst 漏过的竞态）
    let app: { id: number; status: InviteAppStatus }
    try {
      app = await this.prisma.inviteApplication.create({
        data: {
          inviterId: inviter.id,
          username: dto.username,
          email: dto.email,
          phone: dto.phone,
          pendingPhone: dto.phone,
          passwordHash,
          inviteCode: dto.inviteCode,
          status: InviteAppStatus.PENDING,
        },
        select: { id: true, status: true },
      })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("该手机号已提交注册申请，待审核，请勿重复提交")
      }
      throw e
    }
    this.logger.log(`invite register: app=${app.id} inviter=${inviter.id} email=${dto.email}`)
    return { applicationId: app.id, status: app.status }
  }

  // ==================== 审批（邀请人） ====================

  /** 审批通过：建/启用被邀请人账号（普通用户，可自助订阅/充值）、继承邀请人折扣、发放 200 注册赠送积分。
   *  名额消费点：实际建号计 1；邀请人 inviteQuota 非 null 且已用数量达上限 → 拒绝。 */
  async approve(applicationId: number, inviterId: number) {
    const app = await this.prisma.inviteApplication.findFirst({
      where: { id: applicationId, inviterId },
    })
    if (!app) throw new NotFoundException("申请不存在")
    return this.approveCore(app)
  }

  // ==================== 审批（运营代审，admin/dist/applications，2026-08-31） ====================

  /**
   * 运营侧申请队列：全平台邀请申请分页（默认全部状态；status/keyword 过滤）。
   * keyword 搜申请人用户名/邮箱/手机号 + 邀请人用户名；申请人手机号脱敏（与后台各列表同口径）。
   */
  async listApplicationsAdmin(query: QueryAdminApplicationsDto) {
    const { page, pageSize, status, keyword } = query
    const where: Prisma.InviteApplicationWhereInput = {
      ...(status && { status }),
      ...(keyword && {
        OR: [
          { username: { contains: keyword } },
          { email: { contains: keyword } },
          { phone: { contains: keyword } },
          { inviter: { username: { contains: keyword } } },
        ],
      }),
    }
    const [rows, total] = await Promise.all([
      this.prisma.inviteApplication.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          status: true,
          username: true,
          email: true,
          phone: true,
          createdAt: true,
          reviewedAt: true,
          inviter: { select: { id: true, username: true } },
        },
      }),
      this.prisma.inviteApplication.count({ where }),
    ])
    return {
      items: rows.map(r => ({ ...r, phone: maskPhone(r.phone) })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  /**
   * 运营代审批通过：不限申请归属（任意邀请人的申请），其余与邀请人自审完全同口径——
   * 仍校验邀请人有效邀请权（被关闭/上级收回后存量申请不得放行）、名额、原子认领、建号发积分。
   */
  async approveByAdmin(applicationId: number) {
    const app = await this.prisma.inviteApplication.findUnique({ where: { id: applicationId } })
    if (!app) throw new NotFoundException("申请不存在")
    return this.approveCore(app)
  }

  /**
   * 运营代驳回：驳回是清理动作（释放待审手机号占用），不卡邀请人当前权限；
   * 与邀请人自审同口径的原子认领（id+status=PENDING），并发/重复只有一个终态。
   */
  async rejectByAdmin(applicationId: number) {
    const app = await this.prisma.inviteApplication.findUnique({ where: { id: applicationId } })
    if (!app) throw new NotFoundException("申请不存在")
    const claim = await this.prisma.inviteApplication.updateMany({
      where: { id: applicationId, status: InviteAppStatus.PENDING },
      data: { status: InviteAppStatus.REJECTED, reviewedAt: new Date(), pendingPhone: null },
    })
    if (claim.count === 0) throw new BadRequestException("该申请已处理")
    return { applicationId, status: InviteAppStatus.REJECTED }
  }

  /** 审批通过核心（邀请人自审/运营代审共用）：app 为已按归属口径取到的申请行。 */
  private async approveCore(app: InviteApplication) {
    const inviterId = app.inviterId
    if (app.status !== InviteAppStatus.PENDING) throw new BadRequestException("该申请已处理")

    const phoneTaken = await this.prisma.user.findUnique({ where: { phone: app.phone } })
    if (phoneTaken) throw new ConflictException("该手机号已注册，无法通过审核")

    const inviter = await this.prisma.user.findUnique({
      where: { id: inviterId },
      select: {
        canInvite: true,
        discount: true,
        inviteQuota: true,
        subInviteAllowed: true, // 开着时新审批通过的下级落库即带邀请权（2026-09-01 落库制）
        orgs: { select: { orgId: true } },
      },
    })
    if (!inviter) throw new NotFoundException("邀请人不存在")
    // 与 §4 其它接口同口径：被后台关闭邀请权限（或被上级批量收回）后，存量待审申请也不得再放行
    if (!inviter.canInvite) throw new ForbiddenException("当前账号未开启邀请权限")

    const created = await this.prisma
      .$transaction(async tx => {
        // 锁邀请人行（FOR UPDATE 当前读）：同一邀请人的并发审批串行化，否则名额校验是快照读、会被并发击穿
        await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${inviterId} FOR UPDATE`
        // 原子认领申请（条件更新 id+status=PENDING）：并发 approve/reject 只有一个能认领成功，
        // 其余 count=0 → 400，不会重复建号/发积分或留下「已建号但申请被拒绝」的错乱状态
        const claim = await tx.inviteApplication.updateMany({
          where: { id: app.id, status: InviteAppStatus.PENDING },
          // 清空 pendingPhone 释放条件唯一占用（此时已建正式账号，再注册会被 User.phone 唯一拦截）
          data: { status: InviteAppStatus.APPROVED, reviewedAt: new Date(), pendingPhone: null },
        })
        if (claim.count === 0) throw new BadRequestException("该申请已处理")
        // 名额校验（锁内重数，防并发超批）
        if (inviter.inviteQuota != null) {
          const used = await tx.user.count({ where: { invitedById: inviterId } })
          if (used >= inviter.inviteQuota) {
            throw new BadRequestException(
              `邀请名额已用完（${used}/${inviter.inviteQuota}），请联系平台调整`
            )
          }
        }
        // 邀请人开着「下级可继续邀请」→ 新下级落库即带邀请权 + 邀请码（2026-09-01 落库制；
        // 新用户无人工关闭史，canInviteManualOff 默认 false 参与以后上级批量打开）
        const derivedInvite = inviter.subInviteAllowed
        const user = await tx.user.create({
          data: {
            username: app.username ?? this.deriveUsername(app.email, app.phone),
            phone: app.phone,
            // 注册时已验证归属的邮箱一并入库：到期提醒邮件/收据默认邮箱都读 User.email
            email: app.email,
            password: app.passwordHash,
            balance: 0, // 积分原生用户，不发放旧版人民币额度
            invitedById: inviterId,
            // membershipLevel 默认 NONE：被邀请人=普通用户（不再是 LV4），返利沿 invitedById 关系上溯
            discount: inviter.discount, // 继承邀请人当时的折扣
            ...(derivedInvite
              ? {
                  canInvite: true,
                  inviteCode: await this.generateUniqueCode(tx),
                  inviteCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
                }
              : {}),
          },
        })
        // 新用户只绑定配置的默认角色，不继承邀请人角色；组织继续按原规则复制。
        await this.defaultMemberRole.assign(tx, user.id)
        if (inviter.orgs.length) {
          await tx.userOrganization.createMany({
            data: inviter.orgs.map(o => ({ userId: user.id, orgId: o.orgId })),
          })
        }
        // 注册赠送 200 体验积分（GIFT，注册起 30 天过期；邀请注册以审批通过/账号生效时刻为注册时间）
        await this.credit.grant(
          user.id,
          CreditBucket.GIFT,
          SIGNUP_BONUS_CREDITS,
          {
            type: CreditTxnType.SIGNUP_BONUS,
            source: "invite.signup",
            expiresAt: signupBonusExpiresAt(new Date()),
          },
          tx
        )
        return user
      })
      .catch((e: unknown) => {
        // 手机号在事务外快检后到建号前被并发注册（User.phone 唯一兜底）：转 409 而非 500
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          throw new ConflictException("该手机号已注册，无法通过审核")
        }
        throw e
      })
    this.logger.log(`invite approve: app=${app.id} → user=${created.id}`)
    return { userId: created.id, status: InviteAppStatus.APPROVED }
  }

  /** 拒绝申请（可再次邀请）。 */
  async reject(applicationId: number, inviterId: number) {
    // 与 approve 同口径：被关闭邀请权限后不得再处理存量申请
    await this.requireInviter(inviterId)
    const app = await this.prisma.inviteApplication.findFirst({
      where: { id: applicationId, inviterId },
    })
    if (!app) throw new NotFoundException("申请不存在")
    // 原子认领（条件更新 id+inviterId+status=PENDING）：与 approve 并发时只有一个终态，
    // 对方提交后本请求 count=0 → 400「该申请已处理」
    const claim = await this.prisma.inviteApplication.updateMany({
      where: { id: applicationId, inviterId, status: InviteAppStatus.PENDING },
      // 清空 pendingPhone 释放条件唯一占用，允许该手机号被重新邀请注册
      data: { status: InviteAppStatus.REJECTED, reviewedAt: new Date(), pendingPhone: null },
    })
    if (claim.count === 0) throw new BadRequestException("该申请已处理")
    return { applicationId, status: InviteAppStatus.REJECTED }
  }

  // ==================== 返利提现（邀请人） ====================

  /** 返利汇总：累计返利 / 已提现 / 可提现。 */
  async getRebateSummary(userId: number) {
    const [earned, withdrawn, available] = await Promise.all([
      this.prisma.creditTransaction.aggregate({
        where: { userId, type: CreditTxnType.REBATE_IN },
        _sum: { amount: true },
      }),
      this.prisma.creditTransaction.aggregate({
        where: { userId, type: CreditTxnType.REBATE_WITHDRAW },
        _sum: { amount: true },
      }),
      this.prisma.creditLot.aggregate({
        where: { userId, bucket: CreditBucket.REBATE, status: "ACTIVE", remaining: { gt: 0 } },
        _sum: { remaining: true },
      }),
    ])
    return {
      earned: (earned._sum.amount ?? new Prisma.Decimal(0)).toString(),
      withdrawn: (withdrawn._sum.amount ?? new Prisma.Decimal(0)).toString(),
      available: (available._sum.remaining ?? new Prisma.Decimal(0)).toString(),
    }
  }

  /** 返利提现明细（分页）。 */
  async listWithdrawals(userId: number, pagination: PaginationDto) {
    const { page, pageSize } = pagination
    const where = { userId, type: CreditTxnType.REBATE_WITHDRAW }
    const [items, total] = await Promise.all([
      this.prisma.creditTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, amount: true, meta: true, createdAt: true },
      }),
      this.prisma.creditTransaction.count({ where }),
    ])
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }

  /**
   * 返利提现。不卡邀请权限：关闭 canInvite 只停止新增邀请与后续计佣，
   * 历史 REBATE 批次保留、可正常提完（REBATE 桶不可消费，提现是唯一出口，锁死即永久沉淀）。
   */
  async withdraw(userId: number, amount: number, note?: string) {
    const res = await this.credit.withdrawRebate(userId, amount, { note })
    return { withdrawn: res.withdrawn.toString(), balanceAfter: res.balanceAfter.toString() }
  }

  // ==================== 内部工具 ====================

  private async requireInviter(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        canInvite: true,
        shareCreditsWithInvitees: true,
        inviteCode: true,
        inviteCodeExpiresAt: true,
        inviteQuota: true,
        subInviteAllowed: true,
        rebateRate: true, // networkStats 待结算返利比例（一级）
        level2RebateRate: true, // 同上（二级）
        invitedById: true, // 2026-09-02 bug23：被邀请人视角裁剪上游返利比例用
      },
    })
    if (!user) throw new NotFoundException("用户不存在")
    // 有效邀请权 = 本人 canInvite 落库值（2026-09-01 起落库制，废上级开关读时派生——
    // 上级开开关时已批量落库，收回时已批量清库）
    if (!user.canInvite) throw new ForbiddenException("当前账号未开启邀请权限")
    return user
  }

  /** 取有效邀请人（邀请码存在、邀请权在库、账号未停用、名额未用尽、未过期），否则 400。 */
  private async findValidInviter(code: string, tx: Prisma.TransactionClient = this.prisma) {
    const inviter = await tx.user.findUnique({
      where: { inviteCode: code },
      select: {
        id: true,
        username: true,
        canInvite: true,
        isActive: true,
        inviteQuota: true,
        inviteCodeExpiresAt: true,
        discount: true,
        subInviteAllowed: true,
      },
    })
    if (
      !inviter ||
      !inviter.isActive || // 账号已停用：旧邀请码立即失效（公开校验/注册同一入口拦截；启用后自动恢复）
      !inviter.canInvite || // 邀请权已收回（单人关闭或上级批量收回），邀请码同步失效
      !inviter.inviteCodeExpiresAt ||
      inviter.inviteCodeExpiresAt <= new Date()
    ) {
      throw new BadRequestException("无效链接（邀请码不存在或已过期）")
    }
    // 名额在入口即拦截（与 approve 锁内校验同口径：实际建号人数计占用）——
    // 不拦会产出永远无法审批的死单（用户走完验证码+注册全流程才被拒）
    if (inviter.inviteQuota != null) {
      const used = await tx.user.count({ where: { invitedById: inviter.id } })
      if (used >= inviter.inviteQuota) {
        throw new BadRequestException("该邀请链接名额已用完，请联系邀请人")
      }
    }
    return inviter
  }

  /** 惰性保鲜：邀请码缺失/过期则重新生成。 */
  private async ensureFreshCode(user: {
    id: number
    inviteCode: string | null
    inviteCodeExpiresAt: Date | null
  }) {
    if (user.inviteCode && user.inviteCodeExpiresAt && user.inviteCodeExpiresAt > new Date()) {
      return { inviteCode: user.inviteCode, inviteCodeExpiresAt: user.inviteCodeExpiresAt }
    }
    return this.refreshCode(user.id)
  }

  private async generateUniqueCode(tx?: Prisma.TransactionClient): Promise<string> {
    const client = tx ?? this.prisma
    for (let i = 0; i < 10; i++) {
      let code = "OS"
      for (let j = 0; j < 4; j++) {
        code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
      }
      const exists = await client.user.findUnique({
        where: { inviteCode: code },
        select: { id: true },
      })
      if (!exists) return code
    }
    throw new BadRequestException("邀请码生成失败，请重试")
  }

  /**
   * 核销邮箱验证码。置用用条件 updateMany 原子占位：并发下同一张码只会成功一次。
   * 码不匹配时给该邮箱当前有效码记一次失败，连续失败 ≥ EMAIL_CODE_MAX_ATTEMPTS 直接作废（防爆破 6 位码）。
   */
  private async consumeEmailCode(email: string, code: string): Promise<boolean> {
    const record = await this.prisma.emailCode.findFirst({
      where: { email, used: false, expiredAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    })
    if (!record) return false
    if (record.code !== code) {
      const attempts = record.attempts + 1
      await this.prisma.emailCode.update({
        where: { id: record.id },
        data: { attempts, used: attempts >= EMAIL_CODE_MAX_ATTEMPTS },
      })
      return false
    }
    const r = await this.prisma.emailCode.updateMany({
      where: { id: record.id, used: false },
      data: { used: true },
    })
    return r.count > 0
  }

  private deriveUsername(email: string, phone: string): string {
    const local = email.split("@")[0]?.trim()
    return local && local.length > 0 ? local.slice(0, 50) : phone
  }

  private async getInviteOverview(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        canInvite: true,
        discount: true,
        rebateRate: true,
        shareCreditsWithInvitees: true,
        inviteCode: true,
        inviteCodeExpiresAt: true,
        membershipLevel: true,
      },
    })
    if (!user) return user
    const { shareCreditsWithInvitees, ...rest } = user
    return { ...rest, shareCredits: shareCreditsWithInvitees }
  }
}
