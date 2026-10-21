import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import {
  CreditBucket,
  CreditDirection,
  CreditLotStatus,
  CreditTxnType,
  MembershipLevel,
  Prisma,
  ScheduledPlanStatus,
  Team,
  TeamMember,
  TeamRole,
  TeamSource,
  TeamStatus,
} from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import * as argon2 from "argon2"
import { DefaultMemberRoleService } from "../common/services/default-member-role.service"
import { beijingMonthStart } from "../common/utils/datetime"
import { CreditService } from "../membership/credit.service"
import { DAY_MS } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"
import { collectAuditUserIds, describeAuditLog } from "./audit-description"
import { AdjustTeamDto, CreateCustomTeamDto, QueryTeamsDto, UpdateTeamDto } from "./dto/admin.dto"
import { AddMemberDto, UpdateSettingsDto } from "./dto/console.dto"
import { TeamPoolService } from "./team-pool.service"
import {
  SYSTEM_ACTOR_ID,
  TEAM_GRACE_DAYS,
  TeamAuditAction,
  TeamAuditActionValue,
  TeamMemberStatus,
  dataKeepUntilOf,
  graceUntilOf,
  quotaMonthOf,
} from "./team.constants"

type Tx = Prisma.TransactionClient

/** 团队控制台上下文：当前用户的成员关系 + 团队 */
export interface TeamConsoleContext {
  team: Team
  member: TeamMember
}

/** restoreTeam 返回值（M2b 续费/恢复动作共用） */
export interface RestoreTeamResult {
  teamId: number
  status: TeamStatus
  expiresAt: Date
  restoredMemberIds: number[]
  /** 恢复期间已加入其他企业的成员（未自动接回，需管理员重新添加） */
  skippedMembers: { userId: number; reason: string }[]
}

/**
 * 团队生命周期 + 成员 + 席位核心。
 * 生命周期：ACTIVE →（到期）GRACE（宽限 30 天，冻结消费）→（GRACE 满）ARCHIVED
 * （套餐/赠送池清零留痕、充值池退管理员个人户、成员名单保留 status=ARCHIVED）；
 * GRACE/ARCHIVED/DISABLED 经 restoreTeam 恢复 ACTIVE（M2b 订单侧/平台侧触发）。
 */
@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: CreditService,
    private readonly pool: TeamPoolService,
    private readonly defaultMemberRole: DefaultMemberRoleService
  ) {}

  // ==================== 控制台上下文与角色判定 ====================

  /**
   * 当前用户的团队控制台上下文。一个用户可能残留多条成员行（如前团队已归档又加入新团队），
   * 按团队状态优先级取最「活」的一条：ACTIVE > GRACE > DISABLED > ARCHIVED。无团队返回 null。
   */
  async getConsoleContext(userId: number): Promise<TeamConsoleContext | null> {
    const rows = await this.prisma.teamMember.findMany({
      where: { userId },
      include: { team: true },
    })
    if (!rows.length) return null
    const rank: Record<TeamStatus, number> = { ACTIVE: 0, GRACE: 1, DISABLED: 2, ARCHIVED: 3 }
    rows.sort((a, b) => rank[a.team.status] - rank[b.team.status])
    const picked = rows[0]
    return { team: picked.team, member: picked }
  }

  /** 控制台入口：无团队 → 404；成员行被停用/归档仍可读身份（告警条需要） */
  async requireConsoleContext(userId: number): Promise<TeamConsoleContext> {
    const ctx = await this.getConsoleContext(userId)
    if (!ctx) throw new NotFoundException("你尚未加入任何企业团队")
    return ctx
  }

  /** 企业管理动作：须为本团队 ACTIVE 状态的管理员角色 */
  requireTeamAdmin(ctx: TeamConsoleContext): void {
    if (ctx.member.role !== TeamRole.ADMIN || ctx.member.status !== TeamMemberStatus.ACTIVE) {
      throw new ForbiddenException("仅企业管理员可执行该操作")
    }
  }

  /**
   * 控制台只读动作（总览/成员/配额/模型/用量/设置/审计的 GET）：本团队 ACTIVE 管理员；
   * 团队已归档时放行归档管理员（成员行已随归档置 ARCHIVED）只读查看历史数据，
   * 写操作仍由 requireTeamAdmin 拦截。
   */
  requireTeamAdminRead(ctx: TeamConsoleContext): void {
    const archivedView =
      ctx.team.status === TeamStatus.ARCHIVED && ctx.member.status === TeamMemberStatus.ARCHIVED
    if (
      ctx.member.role !== TeamRole.ADMIN ||
      (ctx.member.status !== TeamMemberStatus.ACTIVE && !archivedView)
    ) {
      throw new ForbiddenException("仅企业管理员可执行该操作")
    }
  }

  /** 用户是否已归属其他「占用中」企业（ACTIVE/GRACE 团队的 ACTIVE 成员；唯一归属校验用） */
  async findOccupiedTeamId(
    userId: number,
    excludeTeamId?: number,
    db: Tx = this.prisma
  ): Promise<number | null> {
    const row = await db.teamMember.findFirst({
      where: {
        userId,
        status: TeamMemberStatus.ACTIVE,
        team: { status: { in: [TeamStatus.ACTIVE, TeamStatus.GRACE] } },
        ...(excludeTeamId != null ? { teamId: { not: excludeTeamId } } : {}),
      },
      select: { teamId: true },
    })
    return row?.teamId ?? null
  }

  // ==================== 控制台：身份条 / 总览 / 设置 / 审计 ====================

  /** 顶部身份条数据（各 Tab 常驻） */
  async identity(ctx: TeamConsoleContext) {
    const { team, member } = ctx
    // 席位占用口径：ACTIVE + DISABLED 都占座（停用只限权限不释放席位），仅移出/归档释放；
    // 归档团队成员行已整体置 ARCHIVED，改按归档保留名单统计（与总览/钱包 archivedMemberCount 同口径）
    const [seatsUsed, admin] = await Promise.all([
      this.prisma.teamMember.count({
        where: {
          teamId: team.id,
          status:
            team.status === TeamStatus.ARCHIVED
              ? TeamMemberStatus.ARCHIVED
              : { not: TeamMemberStatus.ARCHIVED },
        },
      }),
      this.prisma.user.findUnique({
        where: { id: team.adminId },
        select: { id: true, username: true, phone: true },
      }),
    ])
    const now = Date.now()
    return {
      team: {
        id: team.id,
        name: team.name,
        nameFilled: team.nameFilled,
        source: team.source,
        status: team.status,
        tier: team.tier,
        seats: team.seats,
        seatsUsed,
        discount: team.discount,
        expiresAt: team.expiresAt,
        daysRemaining: Math.max(0, Math.ceil((team.expiresAt.getTime() - now) / DAY_MS)),
        graceUntil: team.graceUntil,
        dataKeepUntil: team.dataKeepUntil,
        archivedAt: team.archivedAt,
        createdAt: team.createdAt,
        admin,
      },
      myRole: member.role,
      myStatus: member.status,
      joinedAt: member.joinedAt,
    }
  }

  /** 总览 Tab：6 统计卡 + 待处理提醒聚合 */
  async overview(teamId: number) {
    const now = new Date()
    const monthStart = beijingMonthStart(now) // 本月已消耗：北京自然月口径
    // 读时懒重置，保证本月已用/临限名单口径最新；归档团队跳过重置（成员行已冻结，历史用量需原样保留）
    await this.prisma.teamMember.updateMany({
      where: {
        teamId,
        team: { status: { not: TeamStatus.ARCHIVED } },
        OR: [{ quotaMonth: null }, { quotaMonth: { not: quotaMonthOf() } }],
      },
      data: { quotaUsedThisMonth: 0, quotaMonth: quotaMonthOf() },
    })
    const team = await this.prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      include: {
        // 席位/成员统计口径：ACTIVE + DISABLED 都占座（仅移出/归档释放）；
        // 归档团队成员行已整体置 ARCHIVED，改按归档保留名单统计（下方 JS 侧分流，
        // 与 GET /team/members 归档返回集合、钱包 archivedMemberCount 同口径）
        members: {
          include: { user: { select: { id: true, username: true } } },
        },
      },
    })
    const [buckets, grantedTotal, monthAgg, disabledMemberCount] = await Promise.all([
      // GRACE 宽限期：池余额含冻结批次展示（批次物理保留、续费可恢复；标已冻结由前端按 status 渲染）
      this.pool.poolBuckets(teamId, undefined, { includeFrozen: team.status === TeamStatus.GRACE }),
      this.pool.poolGrantedTotal(teamId),
      this.prisma.creditTransaction.aggregate({
        where: { teamId, type: "TEAM_CONSUME", createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      // 停用成员数（不含已移出/ARCHIVED），总览「成员」统计卡用
      this.prisma.teamMember.count({ where: { teamId, status: TeamMemberStatus.DISABLED } }),
    ])

    // 待处理提醒：已达上限 / ≥90% 临限 / 池不足 20%（停用成员不可消费，不参与配额提醒）
    const cappedMembers: { userId: number; username: string }[] = []
    const nearLimitMembers: { userId: number; username: string }[] = []
    for (const m of team.members) {
      if (m.status !== TeamMemberStatus.ACTIVE) continue
      if (m.monthlyQuota == null) continue
      const used = new Decimal(m.quotaUsedThisMonth)
      if (used.greaterThanOrEqualTo(m.monthlyQuota)) {
        cappedMembers.push({ userId: m.userId, username: m.user.username })
      } else if (used.greaterThanOrEqualTo(new Decimal(m.monthlyQuota).mul(0.9))) {
        nearLimitMembers.push({ userId: m.userId, username: m.user.username })
      }
    }
    // 归档团队：成员行已整体置 ARCHIVED，席位/成员按归档保留名单统计（与成员列表同集合）；
    // 提醒类（达限/临限/池不足）只对在期团队有意义，归档只读不下发
    const archived = team.status === TeamStatus.ARCHIVED
    const rosterCount = archived
      ? team.members.filter(m => m.status === TeamMemberStatus.ARCHIVED).length
      : team.members.filter(m => m.status !== TeamMemberStatus.ARCHIVED).length
    const poolLow =
      !archived && grantedTotal.greaterThan(0) && buckets.total.lessThan(grantedTotal.mul(0.2))

    return {
      pool: {
        package: buckets.package, // 套餐积分（30 天清零）
        gift: buckets.gift, // 赠送积分（30 天清零）
        recharge: buckets.recharge, // 充值积分（不清零）
        total: buckets.total, // 剩余可用合计
        grantedTotal, // 累计发放（池不足 20% 提醒的分母）
      },
      monthConsumed: monthAgg._sum.amount ?? new Decimal(0), // 本月已消耗（TEAM_CONSUME 流水）
      seats: { used: rosterCount, total: team.seats },
      memberCount: rosterCount,
      disabledMemberCount, // 停用成员数（不含已移出/ARCHIVED）
      quotaMode: team.quotaMode,
      overLimitPolicy: team.overLimitPolicy,
      reminders: {
        cappedMembers,
        nearLimitMembers,
        poolLow,
      },
    }
  }

  /** 成员管理 Tab：成员列表（含配额口径，读时懒重置；归档团队跳过重置，历史用量原样保留） */
  async listMembers(teamId: number) {
    await this.prisma.teamMember.updateMany({
      where: {
        teamId,
        team: { status: { not: TeamStatus.ARCHIVED } },
        OR: [{ quotaMonth: null }, { quotaMonth: { not: quotaMonthOf() } }],
      },
      data: { quotaUsedThisMonth: 0, quotaMonth: quotaMonthOf() },
    })
    const [team, members] = await Promise.all([
      this.prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { adminId: true } }),
      this.prisma.teamMember.findMany({
        where: { teamId },
        include: { user: { select: { id: true, username: true, phone: true, email: true } } },
        orderBy: { joinedAt: "asc" },
      }),
    ])
    return members.map(m => ({
      userId: m.userId,
      username: m.user.username,
      phone: m.user.phone,
      email: m.user.email,
      role: m.role,
      isTeamAdmin: m.userId === team.adminId,
      status: m.status,
      joinedAt: m.joinedAt,
      monthlyQuota: m.monthlyQuota,
      quotaUsedThisMonth: m.quotaUsedThisMonth,
      quotaRemaining:
        m.monthlyQuota != null
          ? Decimal.max(0, new Decimal(m.monthlyQuota).minus(m.quotaUsedThisMonth))
          : null,
    }))
  }

  /** 设置 Tab 读取 */
  async getSettings(teamId: number) {
    const team = await this.prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      include: { admin: { select: { id: true, username: true, phone: true } } },
    })
    return {
      id: team.id,
      name: team.name,
      nameFilled: team.nameFilled,
      source: team.source,
      tier: team.tier,
      seats: team.seats,
      status: team.status,
      quotaMode: team.quotaMode,
      overLimitPolicy: team.overLimitPolicy,
      discount: team.discount,
      admin: team.admin,
    }
  }

  /** 设置 Tab 更新：企业名称 / 积分模式 / 超额策略（模式切换写审计） */
  async updateSettings(teamId: number, actorId: number, dto: UpdateSettingsDto) {
    if (
      dto.name === undefined &&
      dto.quotaMode === undefined &&
      dto.overLimitPolicy === undefined
    ) {
      throw new BadRequestException("没有需要更新的字段")
    }
    const team = await this.prisma.team.findUnique({ where: { id: teamId } })
    if (!team) throw new NotFoundException("团队不存在")
    await this.prisma.$transaction(async tx => {
      await tx.team.update({
        where: { id: teamId },
        data: {
          ...(dto.name !== undefined
            ? { name: dto.name, nameFilled: dto.name.trim().length > 0 }
            : {}),
          ...(dto.quotaMode !== undefined ? { quotaMode: dto.quotaMode } : {}),
          ...(dto.overLimitPolicy !== undefined ? { overLimitPolicy: dto.overLimitPolicy } : {}),
        },
      })
      await this.audit(tx, teamId, actorId, TeamAuditAction.SETTINGS_UPDATE, {
        from: { name: team.name, quotaMode: team.quotaMode, overLimitPolicy: team.overLimitPolicy },
        to: {
          name: dto.name ?? team.name,
          quotaMode: dto.quotaMode ?? team.quotaMode,
          overLimitPolicy: dto.overLimitPolicy ?? team.overLimitPolicy,
        },
      })
    })
    return this.getSettings(teamId)
  }

  /** 审计日志（设置与日志 Tab，分页；读时补 actorName + 中文 description，前端直接渲染不再翻译 meta） */
  async listAuditLogs(teamId: number, page: number, pageSize: number) {
    const [rows, total] = await Promise.all([
      this.prisma.teamAuditLog.findMany({
        where: { teamId },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.teamAuditLog.count({ where: { teamId } }),
    ])
    // 批量解析用户名：操作者（actorId>0；0=系统）+ meta 里的成员/相关人
    const ids = new Set<number>()
    for (const r of rows) {
      if (r.actorId > SYSTEM_ACTOR_ID) ids.add(r.actorId)
      for (const id of collectAuditUserIds(r.meta)) ids.add(id)
    }
    const users = ids.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, username: true },
        })
      : []
    const nameById = new Map(users.map(u => [u.id, u.username]))
    const nameOf = (id: number | null) => (id != null ? (nameById.get(id) ?? null) : null)
    const items = rows.map(r => ({
      ...r,
      actorName: r.actorId === SYSTEM_ACTOR_ID ? "系统" : (nameById.get(r.actorId) ?? null),
      description: describeAuditLog(r.action, r.meta, nameOf),
    }))
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }

  // ==================== 成员管理 ====================

  /**
   * 添加成员（控制台/平台侧共用入口）：已存在账号（手机号/邮箱）直接拉入；
   * 未注册手机号则开新账号（argon2 初始密码 + mustChangePassword）。
   * 加入即：有效赠送转入企业（保留到期日），终止个人套餐，充值积分保留 + 取消排队单 + 写审计。
   */
  async addMember(teamId: number, actorId: number, dto: AddMemberDto) {
    const account = dto.account.trim()
    if (!account) throw new BadRequestException("成员账号不能为空")
    const isEmail = account.includes("@")
    const user = await this.prisma.user.findFirst({
      where: isEmail ? { email: account } : { phone: account },
    })

    if (user) return this.joinExistingUser(teamId, actorId, user.id, account)

    // 开新账号：仅支持手机号（User.phone 必填唯一）；邮箱拉入仅限已存在账号
    if (isEmail) {
      throw new BadRequestException("该邮箱未注册；开通新成员账号请使用手机号")
    }
    if (!dto.initialPassword) throw new BadRequestException("新成员需设置初始密码（至少 6 位）")
    const password = await argon2.hash(dto.initialPassword)
    // 建号、入队、默认角色及审计原子提交；入队失败不留下未入队的新账号。
    return this.prisma.$transaction(async tx => {
      const created = await tx.user.create({
        data: {
          username: dto.username?.trim() || account,
          phone: account,
          password,
          mustChangePassword: true,
        },
        select: { id: true },
      })
      // 新建账号不发注册赠送积分（成员消费走企业池）。
      return this.joinExistingUserInTx(tx, teamId, actorId, created.id, account, true)
    })
  }

  /** 拉入已存在账号（平台侧按 userId；控制台账号命中后复用） */
  async joinExistingUser(
    teamId: number,
    actorId: number,
    userId: number,
    accountLabel?: string,
    created = false
  ) {
    return this.prisma.$transaction(tx =>
      this.joinExistingUserInTx(tx, teamId, actorId, userId, accountLabel, created)
    )
  }

  private async joinExistingUserInTx(
    tx: Tx,
    teamId: number,
    actorId: number,
    userId: number,
    accountLabel?: string,
    created = false
  ) {
    // 同一账号的并发添加串行化，归属与积分校验均在加锁后的新快照中读取。
    await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${userId} FOR UPDATE`
    const team = await tx.team.findUnique({ where: { id: teamId } })
    if (!team) throw new NotFoundException("团队不存在")
    if (team.status !== TeamStatus.ACTIVE) throw new BadRequestException("团队当前状态不可添加成员")
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, isActive: true },
    })
    if (!user) throw new BadRequestException("成员账号不存在")
    // 平台已停用账号（isActive=false，登录已封）不可拉入企业
    if (!user.isActive) throw new BadRequestException("该账号已停用，不可加入企业团队")

    // 唯一归属校验：一个用户至多归属一个 active 企业（已是本团队成员同样拦截）
    const occupied = await this.findOccupiedTeamId(userId, undefined, tx)
    if (occupied === teamId) throw new BadRequestException("该用户已是本团队成员")
    if (occupied != null) throw new BadRequestException("该用户已归属其他企业，不可重复加入")

    // 套餐积分仍需本人折算；赠送积分允许随成员转入企业，不参与拦截。
    const packageRemaining = await this.credit.consumableBalance(tx, userId, [CreditBucket.PACKAGE])
    if (packageRemaining.greaterThan(0)) {
      throw new BadRequestException(
        `该用户的个人套餐积分未用完（剩余 ${packageRemaining.toString()} 积分），不可直接拉入企业；` +
          "请引导其在「会员充值」页使用「个人转企业」自助转换（剩余价值可折抵），或待套餐积分到期清零后再添加"
      )
    }

    // 席位满拦截（含管理员在内；ACTIVE + DISABLED 都占座——停用不释放席位，仅移出/归档释放）
    const seatsUsed = await tx.teamMember.count({
      where: { teamId, status: { not: TeamMemberStatus.ARCHIVED } },
    })
    if (seatsUsed >= team.seats) throw new BadRequestException("席位已满，请先升级席位")

    if (created) await this.defaultMemberRole.assign(tx, userId)
    const transferredGiftCredits = await this.credit.transferGiftLotsToTeam(userId, teamId, tx)
    await this.joinTeam(tx, teamId, userId, TeamRole.MEMBER)
    await this.audit(tx, teamId, actorId, TeamAuditAction.MEMBER_ADD, {
      userId,
      account: accountLabel ?? String(userId),
      created,
      transferredGiftCredits: transferredGiftCredits.toString(),
    })
    this.logger.log(`addMember team=${teamId} user=${userId} created=${created}`)
    return { userId, teamId, created }
  }

  /** 移出成员：退回个人计费（个人充值包积分仍归本人）；管理员不可移出（须先指定新管理员） */
  async removeMember(teamId: number, actorId: number, memberUserId: number) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } })
    if (!team) throw new NotFoundException("团队不存在")
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: memberUserId } },
    })
    if (!member) throw new NotFoundException("成员不存在")
    if (memberUserId === team.adminId) {
      throw new BadRequestException("管理员不可移出，请先指定新管理员")
    }
    await this.prisma.$transaction(async tx => {
      await tx.teamMember.delete({ where: { teamId_userId: { teamId, userId: memberUserId } } })
      await this.audit(tx, teamId, actorId, TeamAuditAction.MEMBER_REMOVE, {
        userId: memberUserId,
        role: member.role,
      })
    })
    return { userId: memberUserId, removed: true }
  }

  /** 设为管理员（移交：原管理员自动降为成员）/ 设为成员（当前管理员须先移交） */
  async setMemberRole(teamId: number, actorId: number, memberUserId: number, role: TeamRole) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } })
    if (!team) throw new NotFoundException("团队不存在")
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: memberUserId } },
    })
    if (!member || member.status === TeamMemberStatus.ARCHIVED)
      throw new NotFoundException("成员不存在")

    if (role === TeamRole.ADMIN) {
      if (team.adminId === memberUserId) return { userId: memberUserId, role: TeamRole.ADMIN }
      await this.prisma.$transaction(async tx => {
        await tx.teamMember.update({
          where: { teamId_userId: { teamId, userId: memberUserId } },
          data: { role: TeamRole.ADMIN },
        })
        // 原管理员降为成员（成员行可能已被移出，用 updateMany 兜底）
        await tx.teamMember.updateMany({
          where: { teamId, userId: team.adminId },
          data: { role: TeamRole.MEMBER },
        })
        await tx.team.update({ where: { id: teamId }, data: { adminId: memberUserId } })
        await this.audit(tx, teamId, actorId, TeamAuditAction.MEMBER_ROLE, {
          userId: memberUserId,
          role: TeamRole.ADMIN,
          previousAdminId: team.adminId,
        })
      })
    } else {
      if (team.adminId === memberUserId) {
        throw new BadRequestException("不能直接将管理员设为成员，请先把其他成员设为管理员")
      }
      await this.prisma.$transaction(async tx => {
        await tx.teamMember.update({
          where: { teamId_userId: { teamId, userId: memberUserId } },
          data: { role: TeamRole.MEMBER },
        })
        await this.audit(tx, teamId, actorId, TeamAuditAction.MEMBER_ROLE, {
          userId: memberUserId,
          role: TeamRole.MEMBER,
        })
      })
    }
    return { userId: memberUserId, role }
  }

  /** 停用 / 启用成员（停用后不可消费、不占唯一归属？——仍占席位但状态 DISABLED；管理员不可停用） */
  async setMemberStatus(
    teamId: number,
    actorId: number,
    memberUserId: number,
    status: "ACTIVE" | "DISABLED"
  ) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } })
    if (!team) throw new NotFoundException("团队不存在")
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: memberUserId } },
    })
    if (!member || member.status === TeamMemberStatus.ARCHIVED)
      throw new NotFoundException("成员不存在")
    if (memberUserId === team.adminId && status === TeamMemberStatus.DISABLED) {
      throw new BadRequestException("管理员不可停用")
    }
    if (status === TeamMemberStatus.ACTIVE) {
      // 启用前唯一归属校验（停用期间可能已加入其他企业）
      const occupied = await this.findOccupiedTeamId(memberUserId, teamId)
      if (occupied != null) throw new BadRequestException("该用户已归属其他企业，不可启用")
    }
    await this.prisma.$transaction(async tx => {
      await tx.teamMember.update({
        where: { teamId_userId: { teamId, userId: memberUserId } },
        data: { status },
      })
      await this.audit(tx, teamId, actorId, TeamAuditAction.MEMBER_STATUS, {
        userId: memberUserId,
        status,
      })
    })
    return { userId: memberUserId, status }
  }

  // ==================== 平台侧：开通 / 编辑 / 调整 / 停用 / 启用 / 恢复 ====================

  /**
   * 平台定制手工开通（不走订单、不开发收据；合同金额仅留痕）。
   * 池积分：套餐 30 天过期 / 额外充值积分永不过期（TEAM_RECHARGE 带 teamId）。
   */
  async createCustomTeam(actorId: number, dto: CreateCustomTeamDto) {
    const admin = await this.prisma.user.findUnique({ where: { id: dto.adminUserId } })
    if (!admin) throw new BadRequestException("管理员账号不存在")
    const memberIds = [...new Set([dto.adminUserId, ...(dto.memberIds ?? [])])]
    if (memberIds.length > dto.seats) throw new BadRequestException("已选人数超过席位数")
    const users = await this.prisma.user.findMany({
      where: { id: { in: memberIds } },
      select: { id: true },
    })
    if (users.length !== memberIds.length) throw new BadRequestException("存在无效的成员账号")

    // 唯一归属校验（已在别的企业的禁选）
    const occupied = await this.prisma.teamMember.findMany({
      where: {
        userId: { in: memberIds },
        status: TeamMemberStatus.ACTIVE,
        team: { status: { in: [TeamStatus.ACTIVE, TeamStatus.GRACE] } },
      },
      select: { userId: true },
    })
    if (occupied.length) {
      throw new BadRequestException(
        `用户 ${occupied.map(o => `#${o.userId}`).join("、")} 已归属其他企业，不可选入`
      )
    }

    const expiresAt = new Date(dto.expiresAt)
    // timeout 180s：事务内含 建队+逐个入队+池入账+审计 十余次串行写（每成员 4~6 次往返），
    // 高延迟远程库（~0.7s/RT）下 20+ 成员的迁移建队会顶穿 Prisma 默认 5s 与原 15s
    const team = await this.prisma.$transaction(
      async tx => {
        const t = await tx.team.create({
          data: {
            name: dto.name ?? null,
            nameFilled: !!dto.name?.trim(), // 平台定制：后台填了名才算已命名
            source: TeamSource.CUSTOM,
            status: TeamStatus.ACTIVE,
            seats: dto.seats,
            adminId: dto.adminUserId,
            // 企业邀请人快照（企业池消费返利沿此链结算；管理员后续变更不影响）
            invitedById: admin.invitedById ?? null,
            discount: dto.discount != null ? new Decimal(dto.discount) : new Decimal(1),
            expiresAt,
            graceUntil: graceUntilOf(expiresAt),
            dataKeepUntil: dataKeepUntilOf(expiresAt),
            contractAmountCny: dto.contractAmountCny ?? null,
            contractNote: dto.contractNote ?? null,
          },
        })
        for (const uid of memberIds) {
          await this.joinTeam(
            tx,
            t.id,
            uid,
            uid === dto.adminUserId ? TeamRole.ADMIN : TeamRole.MEMBER
          )
        }
        await this.pool.grantPool(
          t.id,
          {
            ownerUserId: dto.adminUserId,
            packageCredits: dto.poolPackageCredits,
            rechargeCredits: dto.poolRechargeCredits,
            source: "admin.team.custom",
            meta: { contractAmountCny: dto.contractAmountCny ?? null },
          },
          tx
        )
        await this.audit(tx, t.id, actorId, TeamAuditAction.TEAM_CREATE, {
          name: dto.name ?? null,
          seats: dto.seats,
          expiresAt: expiresAt.toISOString(),
          poolPackageCredits: dto.poolPackageCredits ?? 0,
          poolRechargeCredits: dto.poolRechargeCredits ?? 0,
          discount: dto.discount ?? 1,
          contractAmountCny: dto.contractAmountCny ?? null,
          contractNote: dto.contractNote ?? null, // 合同备注一并留痕，便于追溯线下合同
          adminUserId: dto.adminUserId,
          memberIds,
        })
        return t
      },
      { timeout: 180_000, maxWait: 15_000 }
    )
    this.logger.log(`createCustomTeam team=${team.id} admin=${dto.adminUserId} seats=${dto.seats}`)
    return this.getAdminTeamDetail(team.id)
  }

  /** 平台侧列表（状态胶囊 + 关键词/来源/到期区间筛选 + 分页；带池与席位概况） */
  async listTeams(query: QueryTeamsDto) {
    const { page, pageSize } = query
    const now = new Date()
    const expiringBefore = new Date(now.getTime() + 7 * DAY_MS)

    const statusWhere: Prisma.TeamWhereInput =
      query.status === "EXPIRING"
        ? { status: TeamStatus.ACTIVE, expiresAt: { gt: now, lte: expiringBefore } }
        : query.status && query.status !== "ALL"
          ? { status: query.status }
          : {}
    // 展示名回落口径：空名团队前端显示「{管理员用户名}的团队」——搜展示名时剥掉「的团队」后缀，
    // 追加按管理员用户名匹配（原三条件保持不变：企业名/管理员名/管理员手机号）
    const keyword = query.keyword?.trim()
    const displayKw = keyword?.replace(/的团队\s*$/, "").trim()
    const where: Prisma.TeamWhereInput = {
      ...statusWhere,
      ...(query.source ? { source: query.source } : {}),
      ...(keyword
        ? {
            OR: [
              { name: { contains: keyword } },
              { admin: { username: { contains: keyword } } },
              { admin: { phone: { contains: keyword } } },
              ...(displayKw && displayKw !== keyword
                ? [{ admin: { username: { contains: displayKw } } } as Prisma.TeamWhereInput]
                : []),
            ],
          }
        : {}),
      ...(query.expiresStart || query.expiresEnd
        ? {
            expiresAt: {
              ...(query.expiresStart ? { gte: new Date(query.expiresStart) } : {}),
              ...(query.expiresEnd ? { lte: new Date(query.expiresEnd) } : {}),
            },
          }
        : {}),
    }

    const [rows, total, statusCounts, expiringCount] = await Promise.all([
      this.prisma.team.findMany({
        where,
        include: {
          admin: {
            select: {
              id: true,
              username: true,
              phone: true,
              roles: {
                select: { role: { select: { id: true, code: true, name: true, color: true } } },
              },
            },
          },
          // 席位占用口径：ACTIVE + DISABLED 都占座（仅移出/归档释放）；
          // 归档企业成员行已整体置 ARCHIVED，seatsUsed 在下方按归档保留名单改算
          _count: {
            select: { members: { where: { status: { not: TeamMemberStatus.ARCHIVED } } } },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.team.count({ where }),
      this.prisma.team.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.team.count({
        where: { status: TeamStatus.ACTIVE, expiresAt: { gt: now, lte: expiringBefore } },
      }),
    ])

    // 归档企业：成员行已整体置 ARCHIVED，席位占用改按归档保留名单统计
    // （与总览/成员列表/钱包 archivedMemberCount 同口径，不再显示 0）
    const archivedSeatBy = new Map<number, number>()
    const archivedIds = rows.filter(t => t.status === TeamStatus.ARCHIVED).map(t => t.id)
    if (archivedIds.length) {
      const counts = await this.prisma.teamMember.groupBy({
        by: ["teamId"],
        where: { teamId: { in: archivedIds }, status: TeamMemberStatus.ARCHIVED },
        _count: { _all: true },
      })
      for (const c of counts) archivedSeatBy.set(c.teamId, c._count._all)
    }

    // 逐行补池概况（每页 ≤pageSize 行，可接受）
    const items = await Promise.all(
      rows.map(async t => {
        const [buckets, grantedTotal] = await Promise.all([
          this.pool.poolBuckets(t.id, undefined, { includeFrozen: t.status === TeamStatus.GRACE }),
          this.pool.poolGrantedTotal(t.id),
        ])
        return {
          id: t.id,
          name: t.name,
          nameFilled: t.nameFilled,
          source: t.source,
          status: t.status,
          tier: t.tier,
          seats: t.seats,
          seatsUsed:
            t.status === TeamStatus.ARCHIVED ? (archivedSeatBy.get(t.id) ?? 0) : t._count.members,
          admin: { ...t.admin, roles: t.admin.roles.map(r => r.role) },
          discount: t.discount,
          expiresAt: t.expiresAt,
          graceUntil: t.graceUntil,
          archivedAt: t.archivedAt,
          createdAt: t.createdAt,
          pool: {
            total: buckets.total,
            grantedTotal,
            remainPct: grantedTotal.greaterThan(0)
              ? buckets.total.div(grantedTotal).mul(100).toDecimalPlaces(1)
              : null,
          },
        }
      })
    )

    const countOf = (s: TeamStatus) => statusCounts.find(c => c.status === s)?._count._all ?? 0
    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      statusCounts: {
        ALL: statusCounts.reduce((s, c) => s + c._count._all, 0),
        ACTIVE: countOf(TeamStatus.ACTIVE),
        EXPIRING: expiringCount,
        GRACE: countOf(TeamStatus.GRACE),
        ARCHIVED: countOf(TeamStatus.ARCHIVED),
        DISABLED: countOf(TeamStatus.DISABLED),
      },
    }
  }

  /** 平台侧详情（含成员子表 + 池概况） */
  async getAdminTeamDetail(teamId: number) {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: {
        admin: { select: { id: true, username: true, phone: true, corpPassUp: true } },
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                phone: true,
                orgs: { select: { org: { select: { id: true, name: true } } } },
                invitedBy: { select: { id: true, username: true } }, // 邀请人（2026-09-02 bug26 分销下钻弹窗）
                roles: {
                  select: { role: { select: { id: true, code: true, name: true, color: true } } },
                }, // 业务角色（2026-09-03 分销下钻成员表「角色」列）
              },
            },
          },
          orderBy: { joinedAt: "asc" },
        },
      },
    })
    if (!team) throw new NotFoundException("团队不存在")
    const memberIds = team.members.map(m => m.userId)
    const [
      buckets,
      grantedTotal,
      consumedRows,
      rebatePersonalRows,
      rebatePoolRows,
      inviterUser,
      ruleRow,
    ] = await Promise.all([
      this.pool.poolBuckets(teamId, undefined, { includeFrozen: team.status === TeamStatus.GRACE }),
      this.pool.poolGrantedTotal(teamId),
      // 成员累计已消耗（全时段）：个人段 CONSUME + 企业段 TEAM_CONSUME 的 DEBIT 合计，与「已消耗」列累计口径一致
      memberIds.length
        ? this.prisma.creditTransaction.groupBy({
            by: ["userId"],
            where: {
              userId: { in: memberIds },
              direction: CreditDirection.DEBIT,
              type: { in: [CreditTxnType.CONSUME, CreditTxnType.TEAM_CONSUME] },
            },
            _sum: { amount: true },
          })
        : Promise.resolve([]),
      // 返利归属（2026-09-02 bug26）：成员个人段——收款人×消费者成对、全历史实付（与关系树 totalAmount 同口径）
      memberIds.length
        ? this.prisma.creditTransaction.groupBy({
            by: ["userId", "relatedUserId"],
            where: {
              type: CreditTxnType.REBATE_IN,
              relatedUserId: { in: memberIds },
            },
            _sum: { amount: true },
          })
        : Promise.resolve([]),
      // 池段返利（REBATE_IN 带 teamId）：受益人按企业聚合，卷起到管理员行（与关系树管理员节点同口径）
      this.prisma.creditTransaction.groupBy({
        by: ["userId"],
        where: { type: CreditTxnType.REBATE_IN, teamId },
        _sum: { amount: true },
      }),
      // 企业自身的上游邀请人（2026-09-03 分销下钻面板）：= Team.invitedById 快照对应用户。
      // 快照无 FK——指向账号可能已注销，查不到按 null（前端整块面板不显示）
      team.invitedById != null
        ? this.prisma.user.findUnique({
            where: { id: team.invitedById },
            select: { id: true, username: true },
          })
        : Promise.resolve(null),
      // 全局 corpCounts（corpRebate.enabled 跟随全局时用）
      this.prisma.rebateRule.findFirst({ orderBy: { id: "asc" } }),
    ])
    const consumedBy = new Map<number, Decimal>(
      consumedRows.map(r => [r.userId, r._sum.amount ?? new Decimal(0)])
    )
    // 返利归属映射：成员个人段按消费者归集；池段卷到管理员行；受益人用户名一次性补查
    const personalRebateBy = new Map<number, Map<number, Decimal>>() // 消费者 → (受益人 → 金额)
    const earnerIds = new Set<number>()
    for (const r of rebatePersonalRows) {
      if (r.relatedUserId == null) continue
      const m = personalRebateBy.get(r.relatedUserId) ?? new Map<number, Decimal>()
      m.set(r.userId, (m.get(r.userId) ?? new Decimal(0)).plus(r._sum.amount ?? 0))
      personalRebateBy.set(r.relatedUserId, m)
      earnerIds.add(r.userId)
    }
    const poolRebateBy = new Map<number, Decimal>() // 受益人 → 池段金额
    for (const r of rebatePoolRows) {
      poolRebateBy.set(
        r.userId,
        (poolRebateBy.get(r.userId) ?? new Decimal(0)).plus(r._sum.amount ?? 0)
      )
      earnerIds.add(r.userId)
    }
    const earnerNameBy = new Map<number, string>()
    if (earnerIds.size) {
      const earners = await this.prisma.user.findMany({
        where: { id: { in: [...earnerIds] } },
        select: { id: true, username: true },
      })
      for (const e of earners) earnerNameBy.set(e.id, e.username)
    }
    const attributionOf = (userId: number, isAdmin: boolean) => {
      const merged = new Map(personalRebateBy.get(userId) ?? new Map<number, Decimal>())
      if (isAdmin) {
        for (const [earner, amt] of poolRebateBy) {
          merged.set(earner, (merged.get(earner) ?? new Decimal(0)).plus(amt))
        }
      }
      return [...merged.entries()]
        .filter(([, amt]) => amt.gt(0))
        .map(([earnerId, amt]) => ({
          userId: earnerId,
          username: earnerNameBy.get(earnerId) ?? `#${earnerId}`,
          amount: amt.toString(), // 全历史实付精确值（4dp 不截断）
        }))
    }
    // 「本企业返利合计」（2026-09-07 bug33 口径修订，废纯池段口径）：= 成员表「返利归属」全量汇总
    //（全部受益人，个人段+池段，全历史实付；池段只卷在管理员行，按成员行加总不双计）——
    // 面板数字与下方成员明细逐项加总必然一致（QA 对账口径）
    const corpRebateTotal = team.members
      .reduce(
        (s, m) =>
          attributionOf(m.userId, m.userId === team.adminId).reduce(
            (s2, a) => s2.plus(a.amount),
            s
          ),
        new Decimal(0)
      )
      .toString()
    return {
      ...team,
      // 企业上游邀请人（2026-09-03）：Team.invitedById 快照对应用户；无快照/账号已注销 → null
      inviter: inviterUser ? { id: inviterUser.id, username: inviterUser.username } : null,
      // 本企业池段计返利状态（与 admin/dist §5.6 corpKids 按 teamId 匹配项同语义）：
      // enabled = 管理员 corpPassUp ?? 全局 corpCounts（逐人设定优先）；overridden = 是否单独设定过（false=跟随全局）
      corpRebate: {
        enabled: team.admin.corpPassUp ?? ruleRow?.corpCounts ?? true,
        overridden: team.admin.corpPassUp != null,
      },
      corpRebateTotal,
      members: team.members.map(m => ({
        userId: m.userId,
        username: m.user.username,
        phone: m.user.phone,
        role: m.role,
        isTeamAdmin: m.userId === team.adminId,
        status: m.status,
        joinedAt: m.joinedAt,
        monthlyQuota: m.monthlyQuota,
        quotaUsedThisMonth: m.quotaUsedThisMonth,
        orgs: m.user.orgs.map(o => ({ id: o.org.id, name: o.org.name })), // 所属组织（同 GET /api/users 口径）
        roles: m.user.roles.map(r => ({
          id: r.role.id,
          code: r.role.code,
          name: r.role.name,
          color: r.role.color,
        })), // 业务角色（同 GET /api/users 结构；无角色=[]）
        consumedTotal: (consumedBy.get(m.userId) ?? new Decimal(0)).toString(), // 累计已消耗（非本月）
        inviter: m.user.invitedBy
          ? { id: m.user.invitedBy.id, username: m.user.invitedBy.username }
          : null, // 邀请人（bug26）
        // 返利归属（全历史实付精确值，>0 才有行；管理员行含本企业池段卷起，与关系树同口径）
        rebateAttribution: attributionOf(m.userId, m.userId === team.adminId),
      })),
      pool: { ...buckets, grantedTotal },
    }
  }

  /** 平台编辑：名称/席位/到期日/折扣/合同；席位不得低于在用，SELF 折扣固定 1 */
  async updateTeam(teamId: number, actorId: number, dto: UpdateTeamDto) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } })
    if (!team) throw new NotFoundException("团队不存在")
    if (
      dto.name === undefined &&
      dto.seats === undefined &&
      dto.expiresAt === undefined &&
      dto.discount === undefined &&
      dto.contractAmountCny === undefined &&
      dto.contractNote === undefined
    ) {
      throw new BadRequestException("没有需要更新的字段")
    }
    if (dto.seats != null) {
      // 在用席位口径：ACTIVE + DISABLED 都占座（停用不释放，仅移出/归档释放）
      const seatsUsed = await this.prisma.teamMember.count({
        where: { teamId, status: { not: TeamMemberStatus.ARCHIVED } },
      })
      if (dto.seats < seatsUsed) {
        throw new BadRequestException(`席位数不得低于当前在用席位（${seatsUsed}）`)
      }
    }
    if (dto.discount != null && team.source === TeamSource.SELF) {
      throw new BadRequestException("自助购买企业的共享池折扣固定为 1，不可调整")
    }
    const newExpiresAt = dto.expiresAt ? new Date(dto.expiresAt) : undefined
    await this.prisma.$transaction(async tx => {
      await tx.team.update({
        where: { id: teamId },
        data: {
          ...(dto.name !== undefined
            ? { name: dto.name, nameFilled: dto.name.trim().length > 0 }
            : {}),
          ...(dto.seats != null ? { seats: dto.seats } : {}),
          ...(newExpiresAt
            ? {
                expiresAt: newExpiresAt,
                graceUntil: graceUntilOf(newExpiresAt),
                dataKeepUntil: dataKeepUntilOf(newExpiresAt),
              }
            : {}),
          ...(dto.discount != null ? { discount: new Decimal(dto.discount) } : {}),
          ...(dto.contractAmountCny !== undefined
            ? { contractAmountCny: dto.contractAmountCny }
            : {}),
          ...(dto.contractNote !== undefined ? { contractNote: dto.contractNote } : {}),
        },
      })
      await this.audit(tx, teamId, actorId, TeamAuditAction.TEAM_UPDATE, { ...dto })
    })
    return this.getAdminTeamDetail(teamId)
  }

  /**
   * 平台调整（客服补偿）：赠送池充值积分（正负皆可，负向减少量不得超过剩余）/ 延长有效期。
   * 宽限期内延长到未来 → 自动回 ACTIVE（等效恢复）。
   */
  async adjustTeam(teamId: number, actorId: number, dto: AdjustTeamDto) {
    if (dto.rechargeCreditsDelta == null && dto.extendDays == null) {
      throw new BadRequestException("没有需要调整的内容")
    }
    if (dto.rechargeCreditsDelta === 0) throw new BadRequestException("调整积分不能为 0")
    const team = await this.prisma.team.findUnique({ where: { id: teamId } })
    if (!team) throw new NotFoundException("团队不存在")

    await this.prisma.$transaction(async tx => {
      if (dto.rechargeCreditsDelta != null) {
        await this.pool.adjustPoolRecharge(
          teamId,
          team.adminId,
          dto.rechargeCreditsDelta,
          {
            source: "admin.team.adjust",
          },
          tx
        )
      }
      if (dto.extendDays != null) {
        const newExpiresAt = new Date(team.expiresAt.getTime() + dto.extendDays * DAY_MS)
        const backToActive = team.status === TeamStatus.GRACE && newExpiresAt.getTime() > Date.now()
        await tx.team.update({
          where: { id: teamId },
          data: {
            expiresAt: newExpiresAt,
            graceUntil: graceUntilOf(newExpiresAt),
            dataKeepUntil: dataKeepUntilOf(newExpiresAt),
            ...(backToActive ? { status: TeamStatus.ACTIVE } : {}),
          },
        })
      }
      await this.audit(tx, teamId, actorId, TeamAuditAction.TEAM_ADJUST, {
        rechargeCreditsDelta: dto.rechargeCreditsDelta ?? null,
        extendDays: dto.extendDays ?? null,
      })
    })
    this.logger.log(
      `adjustTeam team=${teamId} delta=${dto.rechargeCreditsDelta ?? "-"} extend=${dto.extendDays ?? "-"}`
    )
    return this.getAdminTeamDetail(teamId)
  }

  /** 停用企业：成员退回个人计费（状态 DISABLED）、共享池冻结（deductWithQuota 拒绝对非 ACTIVE 团队扣费）；可重新启用 */
  async disableTeam(teamId: number, actorId: number) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } })
    if (!team) throw new NotFoundException("团队不存在")
    if (team.status === TeamStatus.DISABLED) return { id: teamId, status: TeamStatus.DISABLED }
    if (team.status === TeamStatus.ARCHIVED) {
      throw new BadRequestException("已归档团队不可停用")
    }
    await this.prisma.$transaction(async tx => {
      await tx.team.update({ where: { id: teamId }, data: { status: TeamStatus.DISABLED } })
      await tx.teamMember.updateMany({
        where: { teamId, status: TeamMemberStatus.ACTIVE },
        data: { status: TeamMemberStatus.DISABLED },
      })
      await this.audit(tx, teamId, actorId, TeamAuditAction.TEAM_DISABLE, {
        from: team.status,
      })
    })
    this.logger.log(`disableTeam team=${teamId}`)
    return { id: teamId, status: TeamStatus.DISABLED }
  }

  /** 重新启用：DISABLED → ACTIVE（有效期不变；已过期则由生命周期任务再判定），成员接回（已加入他企的跳过） */
  async enableTeam(teamId: number, actorId: number): Promise<RestoreTeamResult> {
    const result = await this.prisma.$transaction(async tx => {
      const team = await tx.team.findUnique({ where: { id: teamId }, include: { members: true } })
      if (!team) throw new NotFoundException("团队不存在")
      if (team.status !== TeamStatus.DISABLED) {
        throw new BadRequestException("仅已停用的团队可重新启用")
      }
      await tx.team.update({ where: { id: teamId }, data: { status: TeamStatus.ACTIVE } })
      const members = await this.reactivateMembers(tx, team)
      await this.audit(tx, teamId, actorId, TeamAuditAction.TEAM_ENABLE, {
        restored: members.restoredMemberIds.length,
        skipped: members.skippedMembers.length,
      })
      return {
        teamId,
        status: TeamStatus.ACTIVE as TeamStatus,
        expiresAt: team.expiresAt,
        ...members,
      }
    })
    this.logger.log(
      `enableTeam team=${teamId} restored=${result.restoredMemberIds.length} skipped=${result.skippedMembers.length}`
    )
    return result
  }

  /**
   * 恢复团队（M2b 续费/恢复动作 + 平台侧恢复共用；签名稳定）：
   * GRACE/ARCHIVED/DISABLED → ACTIVE；expiresAt=now+periodDays，重算 graceUntil/dataKeepUntil，
   * 成员 status 回 ACTIVE——归档/停用期间已加入其他企业的成员跳过并在返回值列出。
   * 宽限期保留的套餐/赠送批次随恢复顺延到新有效期（2026-08-29 起每日任务不再清零团队批次，
   * 宽限期续费即可完整恢复）；已归档团队的批次归档时已清零（充值池已退管理员），本操作对其为 no-op。
   */
  async restoreTeam(
    teamId: number,
    periodDays: number,
    actorId: number,
    tx?: Tx
  ): Promise<RestoreTeamResult> {
    if (!Number.isInteger(periodDays) || periodDays < 1) {
      throw new BadRequestException("恢复天数必须为正整数")
    }
    const run = async (c: Tx) => {
      const team = await c.team.findUnique({ where: { id: teamId }, include: { members: true } })
      if (!team) throw new NotFoundException("团队不存在")
      const restorable: TeamStatus[] = [TeamStatus.GRACE, TeamStatus.ARCHIVED, TeamStatus.DISABLED]
      if (!restorable.includes(team.status)) {
        throw new BadRequestException("团队当前状态无需恢复")
      }
      const now = new Date()
      const expiresAt = new Date(now.getTime() + periodDays * DAY_MS)
      await c.team.update({
        where: { id: teamId },
        data: {
          status: TeamStatus.ACTIVE,
          expiresAt,
          graceUntil: graceUntilOf(expiresAt),
          dataKeepUntil: dataKeepUntilOf(expiresAt),
          archivedAt: null,
        },
      })
      // 存量池套餐批次顺延恢复：GRACE 期间批次到期但未清零（remaining 保留），随恢复延至新有效期；
      // 池充值包本金（永不过期）与赠送（TEAM_PACK/TEAM_CUSTOM 30 天规则）不顺延
      await c.creditLot.updateMany({
        where: {
          teamId,
          sourceType: CreditTxnType.RECHARGE_PLAN,
          bucket: { in: [CreditBucket.PACKAGE, CreditBucket.GIFT] },
          status: CreditLotStatus.ACTIVE,
          remaining: { gt: 0 },
          expiresAt: { lt: expiresAt },
        },
        data: { expiresAt },
      })
      const members = await this.reactivateMembers(c, team)
      await this.audit(c, teamId, actorId, TeamAuditAction.TEAM_RESTORE, {
        from: team.status,
        periodDays,
        expiresAt: expiresAt.toISOString(),
        restored: members.restoredMemberIds.length,
        skipped: members.skippedMembers.length,
      })
      return { teamId, status: TeamStatus.ACTIVE as TeamStatus, expiresAt, ...members }
    }
    const result = tx ? await run(tx) : await this.prisma.$transaction(run)
    this.logger.log(
      `restoreTeam team=${teamId} days=${periodDays} restored=${result.restoredMemberIds.length} skipped=${result.skippedMembers.length}`
    )
    return result
  }

  // ==================== 订单结算接线（BillingSettleService 调用，均在 settle 事务内） ====================

  /**
   * 自助购买 / 个人转团队建队：source=SELF、折扣固定 1、管理员=购买人
   * （joinTeam 同口径：终止其个人套餐/赠送 + 取消个人排队单）。有效期 now+periodDays。
   */
  async createSelfServeTeam(
    opts: {
      name?: string | null
      adminUserId: number
      tier: number
      seats: number
      periodDays: number
    },
    tx: Tx
  ): Promise<Team> {
    const occupied = await tx.teamMember.findFirst({
      where: {
        userId: opts.adminUserId,
        status: TeamMemberStatus.ACTIVE,
        team: { status: { in: [TeamStatus.ACTIVE, TeamStatus.GRACE] } },
      },
      select: { teamId: true },
    })
    if (occupied) throw new BadRequestException("购买人已归属其他企业，无法新建团队")
    // 未填企业名 → 默认「{开通人用户名}的团队」（用户管理「企业归属」列/身份条不再拿到空名）；
    // nameFilled 标记名字是否被显式设置过，供前端判「未命名」提示（不再比对默认名字符串）；
    // 顺带取 invitedById：固化企业邀请人快照（企业池消费返利沿此链结算，管理员变更不影响）
    const admin = await tx.user.findUnique({
      where: { id: opts.adminUserId },
      select: { username: true, invitedById: true },
    })
    let name = opts.name?.trim() || null
    let nameFilled = true
    if (!name) {
      name = `${admin?.username ?? "管理员"}的团队`
      nameFilled = false
    }
    const expiresAt = new Date(Date.now() + opts.periodDays * DAY_MS)
    const team = await tx.team.create({
      data: {
        name,
        nameFilled,
        source: TeamSource.SELF,
        status: TeamStatus.ACTIVE,
        tier: opts.tier,
        seats: opts.seats,
        adminId: opts.adminUserId,
        invitedById: admin?.invitedById ?? null,
        discount: new Decimal(1),
        expiresAt,
        graceUntil: graceUntilOf(expiresAt),
        dataKeepUntil: dataKeepUntilOf(expiresAt),
      },
    })
    await this.joinTeam(tx, team.id, opts.adminUserId, TeamRole.ADMIN)
    await this.audit(tx, team.id, opts.adminUserId, TeamAuditAction.TEAM_CREATE, {
      source: TeamSource.SELF,
      tier: opts.tier,
      seats: opts.seats,
      expiresAt: expiresAt.toISOString(),
    })
    this.logger.log(
      `createSelfServeTeam team=${team.id} admin=${opts.adminUserId} tier=${opts.tier} seats=${opts.seats}`
    )
    return team
  }

  /**
   * 团队续费（**立即生效**，2026-08-25 起废排队制）：团队有效期在「当前到期日」上顺延一个周期，
   * 本期池套餐/赠送积分立即入账（到期日 = 新有效期），tier 立即切换；高等级不能续费低等级。
   * 存量未过期池套餐批次（RECHARGE_PLAN 来源 PACKAGE/GIFT）统一延长到新有效期（2026-08-28 起）。
   * 仅团队在期（ACTIVE 未到期）可调用；GRACE/ARCHIVED 续费走 restoreTeam 恢复链路（settle 分流）。
   */
  async renewTeamImmediateInTx(
    tx: Tx,
    teamId: number,
    snapshot: {
      tier: number
      planName: string
      poolPackageCredits: number
      poolGiftCredits: number
      periodDays: number
    },
    now = new Date(),
    opts: { source?: string; sourceRef?: string; meta?: Record<string, unknown> } = {}
  ) {
    const team = await tx.team.findUnique({ where: { id: teamId } })
    if (!team) throw new NotFoundException("团队不存在")
    if (team.status !== TeamStatus.ACTIVE || team.expiresAt <= now) {
      throw new BadRequestException("团队不在有效期，请使用恢复续费")
    }
    if (team.tier != null && snapshot.tier < team.tier) {
      throw new BadRequestException("高等级套餐不能续费低等级套餐")
    }
    const newExpiry = new Date(team.expiresAt.getTime() + snapshot.periodDays * DAY_MS)
    // 存量池套餐批次顺延（同个人续费口径，2026-08-28 起）：续费前未过期的 RECHARGE_PLAN 来源
    // PACKAGE/GIFT 批次统一延长到新有效期；池充值包本金（永不过期）与赠送（30 天规则）不顺延
    await tx.creditLot.updateMany({
      where: {
        teamId,
        sourceType: CreditTxnType.RECHARGE_PLAN,
        bucket: { in: [CreditBucket.PACKAGE, CreditBucket.GIFT] },
        status: CreditLotStatus.ACTIVE,
        remaining: { gt: 0 },
        expiresAt: { gt: now, lt: newExpiry },
      },
      data: { expiresAt: newExpiry },
    })
    await this.pool.grantPool(
      teamId,
      {
        ownerUserId: team.adminId,
        packageCredits: snapshot.poolPackageCredits,
        giftCredits: snapshot.poolGiftCredits,
        packageExpiresAt: newExpiry,
        source: opts.source ?? "team.renewal",
        sourceRef: opts.sourceRef,
        type: CreditTxnType.RECHARGE_PLAN, // 充值记录归「套餐订阅」
        meta: {
          tier: snapshot.tier,
          name: snapshot.planName,
          expiresAt: newExpiry.toISOString(),
          ...(opts.meta ?? {}),
        },
      },
      tx
    )
    await tx.team.update({
      where: { id: teamId },
      data: {
        tier: snapshot.tier,
        expiresAt: newExpiry,
        graceUntil: graceUntilOf(newExpiry),
        dataKeepUntil: dataKeepUntilOf(newExpiry),
      },
    })
    await this.audit(tx, teamId, team.adminId, TeamAuditAction.TEAM_RENEW, {
      tier: snapshot.tier,
      immediate: true,
      expiresAt: newExpiry.toISOString(),
    })
    return { expiresAt: newExpiry }
  }

  /**
   * 【遗留】团队续费排队（团队在期 ACTIVE 时）：排到「当前到期 + 已排队」队尾，
   * 到期由 activateDueTeamPlans 激活发放。2026-08-25 起改 renewTeamImmediateInTx（立即生效），
   * 本方法仅为历史排队单保留读/激活链路。
   */
  async scheduleTeamRenewalInTx(
    tx: Tx,
    teamId: number,
    snapshot: {
      tier: number
      planName: string
      priceCny: Decimal
      poolPackageCredits: number
      poolGiftCredits: number
      periodDays: number
    },
    now = new Date()
  ) {
    const team = await tx.team.findUnique({ where: { id: teamId } })
    if (!team) throw new NotFoundException("团队不存在")
    const pending = await tx.scheduledPlan.findMany({
      where: { teamId, status: ScheduledPlanStatus.PENDING },
      select: { activateAt: true, periodDays: true },
    })
    const tails: number[] = []
    if (team.expiresAt > now) tails.push(team.expiresAt.getTime())
    for (const p of pending) tails.push(p.activateAt.getTime() + p.periodDays * DAY_MS)
    const activateAt = tails.length ? new Date(Math.max(...tails)) : now
    return tx.scheduledPlan.create({
      data: {
        userId: team.adminId,
        teamId,
        tier: snapshot.tier,
        activateAt,
        planName: snapshot.planName,
        priceCny: snapshot.priceCny,
        packageCredits: snapshot.poolPackageCredits,
        giftCredits: snapshot.poolGiftCredits,
        periodDays: snapshot.periodDays,
      },
    })
  }

  /**
   * 激活某团队到期的排队续费（幂等同个人 activateDuePlans：条件抢占 + 链式追平）：
   * 发池套餐/赠送积分（有效期=新周期末）+ 团队 tier/expiresAt 顺延 + 恢复 ACTIVE
   * （GRACE 直接恢复；ARCHIVED 额外接回成员名单；DISABLED 不激活）。
   */
  async activateDueTeamPlans(teamId: number, now = new Date()): Promise<{ activated: number }> {
    let activated = 0
    for (;;) {
      const result = await this.prisma.$transaction(async tx => {
        const plan = await tx.scheduledPlan.findFirst({
          where: { teamId, status: ScheduledPlanStatus.PENDING, activateAt: { lte: now } },
          orderBy: { activateAt: "asc" },
        })
        if (!plan) return "stop" as const
        const team = await tx.team.findUnique({ where: { id: teamId }, include: { members: true } })
        if (!team || team.status === TeamStatus.DISABLED) return "stop" as const
        // 当前周期仍在有效期 → 队列等待（GRACE/ARCHIVED 视为周期已结束，激活即恢复）
        if (team.status === TeamStatus.ACTIVE && team.expiresAt > now) return "stop" as const
        const claimed = await tx.scheduledPlan.updateMany({
          where: { id: plan.id, status: ScheduledPlanStatus.PENDING },
          data: { status: ScheduledPlanStatus.ACTIVATED, activatedAt: now },
        })
        if (claimed.count !== 1) return "skip" as const
        const expiresAt = new Date(plan.activateAt.getTime() + plan.periodDays * DAY_MS)
        await this.pool.grantPool(
          teamId,
          {
            ownerUserId: team.adminId,
            packageCredits: plan.packageCredits,
            giftCredits: plan.giftCredits,
            packageExpiresAt: expiresAt,
            source: "team.renewal.activate",
            sourceRef: `scheduledPlan:${plan.id}`,
            type: CreditTxnType.RECHARGE_PLAN, // 充值记录归「套餐订阅」
            meta: { tier: plan.tier, name: plan.planName, expiresAt: expiresAt.toISOString() },
          },
          tx
        )
        await tx.team.update({
          where: { id: teamId },
          data: {
            status: TeamStatus.ACTIVE,
            tier: plan.tier,
            expiresAt,
            graceUntil: graceUntilOf(expiresAt),
            dataKeepUntil: dataKeepUntilOf(expiresAt),
            archivedAt: null,
          },
        })
        if (team.status === TeamStatus.ARCHIVED) await this.reactivateMembers(tx, team)
        await this.audit(tx, teamId, SYSTEM_ACTOR_ID, TeamAuditAction.TEAM_RENEW, {
          scheduledPlanId: plan.id,
          tier: plan.tier,
          from: team.status,
          activateAt: plan.activateAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        })
        return "activated" as const
      })
      if (result === "stop") break
      if (result === "activated") activated++
    }
    if (activated) this.logger.log(`activateDueTeamPlans team=${teamId} activated=${activated}`)
    return { activated }
  }

  /** 扫描所有有到期排队续费的团队并激活（生命周期任务在 GRACE 迁移前调用，避免误宽限） */
  async activateAllDueTeamPlans(now = new Date()): Promise<{ activated: number; teams: number }> {
    const due = await this.prisma.scheduledPlan.findMany({
      where: {
        teamId: { not: null },
        status: ScheduledPlanStatus.PENDING,
        activateAt: { lte: now },
      },
      select: { teamId: true },
      distinct: ["teamId"],
    })
    let activated = 0
    let teams = 0
    for (const { teamId } of due) {
      if (teamId == null) continue
      teams++
      const res = await this.activateDueTeamPlans(teamId, now)
      activated += res.activated
    }
    return { activated, teams }
  }

  // ==================== 生命周期（定时任务调用） ====================

  /** 每日生命周期：先激活到期排队续费（已续费团队不误判），再 ACTIVE 到期 → GRACE；GRACE 满 → ARCHIVED */
  async runLifecycle(now = new Date()): Promise<{ grace: number; archived: number }> {
    await this.activateAllDueTeamPlans(now)
    const grace = await this.transitionToGrace(now)
    const archived = await this.transitionToArchived(now)
    return { grace, archived }
  }

  /** ACTIVE 到期 → GRACE（池冻结由 deductWithQuota 非 ACTIVE 拦截生效，graceUntil 建队时已快照） */
  private async transitionToGrace(now: Date): Promise<number> {
    const due = await this.prisma.team.findMany({
      where: { status: TeamStatus.ACTIVE, expiresAt: { lte: now } },
      select: { id: true },
    })
    let count = 0
    for (const t of due) {
      const claimed = await this.prisma.$transaction(async tx => {
        const res = await tx.team.updateMany({
          where: { id: t.id, status: TeamStatus.ACTIVE, expiresAt: { lte: now } },
          data: { status: TeamStatus.GRACE },
        })
        if (!res.count) return false
        await this.audit(tx, t.id, SYSTEM_ACTOR_ID, TeamAuditAction.TEAM_GRACE, {})
        return true
      })
      if (claimed) count++
    }
    if (count) this.logger.log(`生命周期：${count} 个团队到期进入宽限期`)
    return count
  }

  /** GRACE 满 30 天 → ARCHIVED：逐团队走 archiveOneTeam（与手动提前归档同一条路径） */
  private async transitionToArchived(now: Date): Promise<number> {
    const graceDeadline = new Date(now.getTime() - TEAM_GRACE_DAYS * DAY_MS)
    const due = await this.prisma.team.findMany({
      where: {
        status: TeamStatus.GRACE,
        OR: [{ graceUntil: { lte: now } }, { graceUntil: null, expiresAt: { lte: graceDeadline } }],
      },
      select: { id: true },
    })
    let count = 0
    for (const t of due) {
      if (await this.archiveOneTeam(t.id, SYSTEM_ACTOR_ID, now)) count++
    }
    if (count) this.logger.log(`生命周期：${count} 个团队宽限期满归档`)
    return count
  }

  /**
   * 提前归档（企业管理员手动，仅 GRACE）：效果与宽限期满自动归档一致
   * （套餐/赠送池清零留痕、充值池退管理员个人户、成员名单保留 status=ARCHIVED），审计 actorId=操作人。
   * 幂等：已 ARCHIVED 直接返回成功（不重复清零/退回）；ACTIVE/DISABLED 拒绝。
   */
  async archiveEarly(teamId: number, operatorId: number) {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, status: true },
    })
    if (!team) throw new NotFoundException("团队不存在")
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: operatorId } },
      select: { role: true, status: true },
    })
    if (!member || member.status !== TeamMemberStatus.ACTIVE || member.role !== TeamRole.ADMIN) {
      throw new ForbiddenException("仅本团队管理员可执行提前归档")
    }
    if (team.status === TeamStatus.ARCHIVED) return { archived: true, alreadyArchived: true }
    if (team.status !== TeamStatus.GRACE) {
      throw new BadRequestException("仅宽限期（GRACE）内的团队可提前归档")
    }
    await this.archiveOneTeam(teamId, operatorId)
    this.logger.log(`团队 #${teamId} 由管理员 #${operatorId} 提前归档`)
    return { archived: true, alreadyArchived: false }
  }

  /** 单团队归档（GRACE → ARCHIVED，并发抢占幂等）：套餐/赠送池清零留痕、充值池退管理员个人户、成员名单保留（status=ARCHIVED） */
  private async archiveOneTeam(
    teamId: number,
    actorId: number,
    now = new Date()
  ): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      const res = await tx.team.updateMany({
        where: { id: teamId, status: TeamStatus.GRACE },
        data: { status: TeamStatus.ARCHIVED, archivedAt: now },
      })
      if (!res.count) return false
      const team = await tx.team.findUniqueOrThrow({
        where: { id: teamId },
        select: { adminId: true },
      })
      const { returned } = await this.credit.archiveTeamPool(teamId, team.adminId, tx)
      await tx.teamMember.updateMany({
        where: { teamId, status: { not: TeamMemberStatus.ARCHIVED } },
        data: { status: TeamMemberStatus.ARCHIVED },
      })
      await this.audit(tx, teamId, actorId, TeamAuditAction.TEAM_ARCHIVE, {
        returnedToAdmin: returned.toString(),
      })
      return true
    })
  }

  // ==================== 私有 ====================

  /**
   * 加入团队核心动作（事务内）：终止个人套餐（套餐/赠送批次清零，个人充值包积分保留）
   * + 取消 PENDING 排队续费单 + 落成员行（历史残留行复活为 ACTIVE 并重置配额台账）。
   */
  private async joinTeam(tx: Tx, teamId: number, userId: number, role: TeamRole) {
    await this.credit.clearGrantedCredits(userId, tx)
    await this.credit.cancelPendingScheduledPlans(userId, tx)
    // 加入企业即正式终止个人套餐身份（不只清积分）：档位/冗余等级/有效期全清——
    // 企业到期退出后落「无等级」，不能恢复原 Lv.1-3，原有效期只留在订单快照/历史里
    await tx.user.update({
      where: { id: userId },
      data: {
        subscriptionTier: null,
        membershipLevel: MembershipLevel.NONE,
        subscriptionExpiresAt: null,
      },
    })
    await tx.teamMember.upsert({
      where: { teamId_userId: { teamId, userId } },
      create: { teamId, userId, role, status: TeamMemberStatus.ACTIVE, joinedAt: new Date() },
      update: {
        role,
        status: TeamMemberStatus.ACTIVE,
        joinedAt: new Date(),
        monthlyQuota: null,
        quotaUsedThisMonth: 0,
        quotaMonth: null,
      },
    })
  }

  /** 恢复/启用时接回成员：非 ACTIVE 成员置回 ACTIVE；已加入其他 active 企业的跳过并列出 */
  private async reactivateMembers(
    tx: Tx,
    team: Team & { members: TeamMember[] }
  ): Promise<{
    restoredMemberIds: number[]
    skippedMembers: { userId: number; reason: string }[]
  }> {
    const restoredMemberIds: number[] = []
    const skippedMembers: { userId: number; reason: string }[] = []
    for (const m of team.members) {
      if (m.status === TeamMemberStatus.ACTIVE) {
        restoredMemberIds.push(m.userId)
        continue
      }
      const occupied = await tx.teamMember.findFirst({
        where: {
          userId: m.userId,
          status: TeamMemberStatus.ACTIVE,
          team: { status: { in: [TeamStatus.ACTIVE, TeamStatus.GRACE] }, id: { not: team.id } },
        },
        select: { teamId: true },
      })
      if (occupied) {
        skippedMembers.push({ userId: m.userId, reason: "归档/停用期间已加入其他企业，需重新添加" })
        continue
      }
      await tx.teamMember.update({
        where: { teamId_userId: { teamId: team.id, userId: m.userId } },
        data: { status: TeamMemberStatus.ACTIVE },
      })
      restoredMemberIds.push(m.userId)
    }
    return { restoredMemberIds, skippedMembers }
  }

  /** 写团队审计日志（所有管理动作；订单结算侧的建队/升级/池入账同样调用） */
  audit(
    tx: Tx,
    teamId: number,
    actorId: number,
    action: TeamAuditActionValue,
    meta: Record<string, unknown>
  ) {
    return tx.teamAuditLog.create({
      data: { teamId, actorId, action, meta: meta as Prisma.InputJsonValue },
    })
  }
}
