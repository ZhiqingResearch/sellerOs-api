import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import {
  InvokeType,
  OverLimitPolicy,
  Prisma,
  TeamMember,
  TeamQuotaMode,
  TeamStatus,
} from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { beijingMonthStart } from "../common/utils/datetime"
import { ConsumeResult, CreditService } from "../membership/credit.service"
import { PrismaService } from "../prisma/prisma.service"
import { TeamPoolService } from "./team-pool.service"
import { TeamAuditAction, TeamMemberStatus, quotaMonthOf } from "./team.constants"

type Tx = Prisma.TransactionClient

/** deductWithQuota 返回值：消费结果 + 配额台账快照 */
export interface DeductWithQuotaResult extends ConsumeResult {
  quotaMonth: string // 当前配额月份（懒重置后）
  quotaUsedThisMonth: Decimal // 扣后本月已用
  monthlyQuota: number | null // 月度上限（null=不限）
  quotaRemaining: Decimal | null // 剩余额度（不限时为 null）
  warnExceeded: boolean // WARN 策略下本次已超上限仍放行
}

/**
 * 月度配额台账 + 懒重置（提额申请/审批链路已下线，额度只能由管理员直接调整）。
 * 配额语义：SHARED 模式 monthlyQuota=成员月度封顶（超额策略 BLOCK/WARN）；INDEPENDENT 模式=固定配额（硬上限）。
 * quotaMonth("2026-08") 懒重置：读/扣时跨月则清零重计。
 */
@Injectable()
export class TeamQuotaService {
  private readonly logger = new Logger(TeamQuotaService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: CreditService,
    private readonly pool: TeamPoolService
  ) {}

  /** 当前配额月份标记（委托常量，供外部复用同口径） */
  quotaMonthOf(date = new Date()): string {
    return quotaMonthOf(date)
  }

  /** 团队消费公开入口（签名稳定，供消费路由接入；可并入外层事务 tx） */
  async deductWithQuota(
    teamId: number,
    userId: number,
    credits: Decimal | number | string,
    costCny: Decimal | number | string,
    opts: {
      source?: string
      meta?: Record<string, unknown>
      allowOverdraft?: boolean
      invokeType?: InvokeType
    } = {},
    tx?: Tx
  ): Promise<DeductWithQuotaResult> {
    const charge = new Decimal(credits)
    const cost = new Decimal(costCny)
    if (charge.lessThanOrEqualTo(0)) throw new BadRequestException("消费积分必须大于 0")
    const run = async (c: Tx) => {
      const team = await c.team.findUnique({
        where: { id: teamId },
        select: { id: true, status: true, quotaMode: true, overLimitPolicy: true },
      })
      if (!team) throw new NotFoundException("团队不存在")
      // 生命周期冻结：仅 ACTIVE 可消费（GRACE 宽限/ARCHIVED 归档/DISABLED 停用一律冻结）
      if (team.status !== TeamStatus.ACTIVE) {
        throw new BadRequestException(
          team.status === TeamStatus.GRACE
            ? "团队版已到期，共享积分池已冻结，请联系企业管理员续费"
            : "团队当前不可用，共享积分池已冻结"
        )
      }
      // 懒重置（同事务内）：跨月则清零重计
      const member = await this.resetQuotaIfNewMonth(c, teamId, userId)

      // 配额预检：INDEPENDENT 恒为硬上限；SHARED 看 overLimitPolicy
      let warnExceeded = false
      if (team.quotaMode === TeamQuotaMode.INDEPENDENT && member.monthlyQuota == null) {
        throw new BadRequestException("当前为独立配额模式且未分配额度，请联系企业管理员分配")
      }
      if (member.monthlyQuota != null) {
        const exceeds = new Decimal(member.quotaUsedThisMonth)
          .plus(charge)
          .greaterThan(member.monthlyQuota)
        if (exceeds) {
          const hardBlock =
            team.quotaMode === TeamQuotaMode.INDEPENDENT ||
            team.overLimitPolicy === OverLimitPolicy.BLOCK
          if (hardBlock) {
            throw new BadRequestException("已达本月使用上限，请联系企业管理员调整额度")
          }
          warnExceeded = true
        }
      }

      // 扣池（FOR UPDATE 行锁在内核内）→ 累加本月已用（同事务）
      const result = await this.credit.consumeTeamCredits(teamId, userId, charge, cost, opts, c)
      const updated = await c.teamMember.update({
        where: { teamId_userId: { teamId, userId } },
        data: {
          quotaUsedThisMonth: new Decimal(member.quotaUsedThisMonth).plus(result.creditsCharged),
          quotaMonth: quotaMonthOf(),
        },
      })
      const quotaRemaining =
        member.monthlyQuota != null
          ? Decimal.max(0, new Decimal(member.monthlyQuota).minus(updated.quotaUsedThisMonth))
          : null
      if (warnExceeded) {
        this.logger.warn(`deductWithQuota team=${teamId} user=${userId} 已超月度上限（WARN 放行）`)
      }
      return {
        ...result,
        quotaMonth: updated.quotaMonth ?? quotaMonthOf(),
        quotaUsedThisMonth: updated.quotaUsedThisMonth,
        monthlyQuota: member.monthlyQuota,
        quotaRemaining,
        warnExceeded,
      }
    }
    return tx
      ? run(tx)
      : this.prisma.$transaction(run, {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        })
  }

  /** 批量懒重置：把团队内跨月成员的本月已用清零（读路径调用，保证展示口径最新）；归档团队跳过重置（历史用量原样保留） */
  async refreshTeamQuota(teamId: number, tx?: Tx): Promise<void> {
    const month = quotaMonthOf()
    const run = (c: Tx | PrismaService) =>
      c.teamMember.updateMany({
        where: {
          teamId,
          team: { status: { not: TeamStatus.ARCHIVED } },
          OR: [{ quotaMonth: null }, { quotaMonth: { not: month } }],
        },
        data: { quotaUsedThisMonth: 0, quotaMonth: month },
      })
    if (tx) await run(tx)
    else await run(this.prisma)
  }

  /** 积分与配额 Tab：池卡片 + 成员配额列表（读时先懒重置） */
  async listQuota(teamId: number) {
    await this.refreshTeamQuota(teamId)
    // 本月已消耗：北京自然月口径（与 overview、配额懒重置同切点）
    const monthStart = beijingMonthStart()
    const team = await this.prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: {
        quotaMode: true,
        overLimitPolicy: true,
        adminId: true,
        expiresAt: true,
        status: true,
      },
    })
    const [buckets, grantedTotal, monthAgg, members] = await Promise.all([
      // GRACE 宽限期：池余额含冻结批次展示（物理保留、续费可恢复）
      this.pool.poolBuckets(teamId, undefined, { includeFrozen: team.status === TeamStatus.GRACE }),
      this.pool.poolGrantedTotal(teamId),
      // 本月已消耗（与 overview 同口径：TEAM_CONSUME 流水合计）
      this.prisma.creditTransaction.aggregate({
        where: { teamId, type: "TEAM_CONSUME", createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      // 在期：ACTIVE+DISABLED 占座口径；归档团队：按归档保留名单展示历史限额
      // （与成员列表/overview 归档口径同集合，前端只读渲染并标「已归档」）
      this.prisma.teamMember.findMany({
        where: { teamId },
        include: { user: { select: { id: true, username: true, phone: true } } },
        orderBy: { joinedAt: "asc" },
      }),
    ])
    const archived = team.status === TeamStatus.ARCHIVED
    const roster = members.filter(m =>
      archived ? m.status === TeamMemberStatus.ARCHIVED : m.status !== TeamMemberStatus.ARCHIVED
    )
    return {
      quotaMode: team.quotaMode,
      overLimitPolicy: team.overLimitPolicy,
      pool: {
        ...buckets,
        grantedTotal, // 总积分（当前周期获得总额）
        monthConsumed: monthAgg._sum.amount ?? 0, // 本月已消耗
        expiresAt: team.expiresAt, // 套餐/赠送积分清零日期（随团队有效期）
      },
      members: roster.map(m => this.toQuotaRow(m, team.adminId)),
    }
  }

  /** 调整成员月度上限（null=不限）；写审计 */
  async setMemberQuota(
    teamId: number,
    actorId: number,
    memberUserId: number,
    quota: number | null
  ) {
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: memberUserId } },
    })
    if (!member || member.status === TeamMemberStatus.ARCHIVED) {
      throw new NotFoundException("成员不存在")
    }
    await this.prisma.$transaction(async tx => {
      await tx.teamMember.update({
        where: { teamId_userId: { teamId, userId: memberUserId } },
        data: { monthlyQuota: quota },
      })
      await tx.teamAuditLog.create({
        data: {
          teamId,
          actorId,
          action: TeamAuditAction.QUOTA_UPDATE,
          meta: {
            memberUserId,
            monthlyQuota: quota,
            // 变更前值（审计描述「由 x 调整为 y」；老行无此字段只显示新值）
            monthlyQuotaBefore: member.monthlyQuota == null ? null : Number(member.monthlyQuota),
          },
        },
      })
    })
    return { userId: memberUserId, monthlyQuota: quota }
  }

  /** 批量分配：统一设置成员月度上限（不覆盖管理员角色成员）；写审计 */
  async batchSetQuota(teamId: number, actorId: number, quota: number | null) {
    const res = await this.prisma.$transaction(async tx => {
      const r = await tx.teamMember.updateMany({
        where: { teamId, role: "MEMBER", status: { not: TeamMemberStatus.ARCHIVED } },
        data: { monthlyQuota: quota },
      })
      await tx.teamAuditLog.create({
        data: {
          teamId,
          actorId,
          action: TeamAuditAction.QUOTA_BATCH,
          meta: { monthlyQuota: quota, affected: r.count },
        },
      })
      return r
    })
    return { affected: res.count, monthlyQuota: quota }
  }

  /** 懒重置：读成员行，quotaMonth 非当前月则同事务清零重计；非本团队 ACTIVE 成员抛错 */
  private async resetQuotaIfNewMonth(c: Tx, teamId: number, userId: number): Promise<TeamMember> {
    const member = await c.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    })
    if (!member) throw new ForbiddenException("你不是该团队成员")
    if (member.status !== TeamMemberStatus.ACTIVE) {
      throw new ForbiddenException("成员状态不可用，请联系企业管理员")
    }
    const month = quotaMonthOf()
    if (member.quotaMonth !== month) {
      return c.teamMember.update({
        where: { teamId_userId: { teamId, userId } },
        data: { quotaUsedThisMonth: 0, quotaMonth: month },
      })
    }
    return member
  }

  private toQuotaRow(
    m: TeamMember & { user: { id: number; username: string; phone: string } },
    adminId: number
  ) {
    const remaining =
      m.monthlyQuota != null
        ? Decimal.max(0, new Decimal(m.monthlyQuota).minus(m.quotaUsedThisMonth))
        : null
    return {
      userId: m.userId,
      username: m.user.username,
      phone: m.user.phone,
      role: m.role,
      isTeamAdmin: m.userId === adminId,
      status: m.status,
      monthlyQuota: m.monthlyQuota,
      quotaUsedThisMonth: m.quotaUsedThisMonth,
      quotaRemaining: remaining,
      quotaMonth: m.quotaMonth,
    }
  }
}
