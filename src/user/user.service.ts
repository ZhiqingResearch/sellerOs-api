import {
  BadRequestException,
  ConflictException,
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
  HistoryType,
  Prisma,
  TeamStatus,
} from "@prisma/client"
import * as argon2 from "argon2"
import { maskPhone } from "../common/utils/mask"
import { CreditService } from "../membership/credit.service"
import { SIGNUP_BONUS_CREDITS, signupBonusExpiresAt } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"
import { SmsService } from "../sms/sms.service"
import { CreateUserDto } from "./dto/create-user.dto"
import { QueryUserDto } from "./dto/query-user.dto"
import { UpdateUserDto } from "./dto/update-user.dto"
import { BatchCreateUserDto, MoveOrgDto } from "./dto/user-misc.dto"
import { RoleOptionDto, UserItemDto, UserListDto } from "./dto/user-response.dto"

/** 列表/详情统一的 select：用户基础字段 + 角色简要 + 组织简要 + 会员/邀请/企业归属视图列 */
const USER_ITEM_SELECT = {
  id: true,
  username: true,
  phone: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  subscriptionTier: true,
  membershipLevel: true,
  canInvite: true,
  invitedById: true,
  rebateEnabled: true,
  rebateRate: true, // 一级返佣比例（用户管理「邀请/返佣」列展示「团队长 · 返佣 30%」用）
  invitedBy: { select: { id: true, username: true } },
  // ACTIVE + DISABLED 成员行都带出：停用成员席位仍占着，企业归属列要标「已停用」而不是回落个人计费
  teamMemberships: {
    where: { status: { in: ["ACTIVE", "DISABLED"] } },
    select: {
      role: true,
      status: true,
      team: { select: { id: true, name: true, source: true, status: true } },
    },
  },
  roles: { select: { role: { select: { id: true, code: true, name: true, color: true } } } },
  orgs: { select: { org: { select: { id: true, name: true } } } },
} satisfies Prisma.UserSelect

type UserItemRow = Prisma.UserGetPayload<{ select: typeof USER_ITEM_SELECT }>

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly smsService: SmsService,
    private readonly config: ConfigService,
    private readonly credit: CreditService
  ) {}

  /** 后台建号发放的 200 注册赠送积分（GIFT，注册起 30 天过期），与邀请注册口径一致。 */
  private grantSignupBonus(userId: number, tx: Prisma.TransactionClient) {
    return this.credit.grant(
      userId,
      CreditBucket.GIFT,
      SIGNUP_BONUS_CREDITS,
      {
        type: CreditTxnType.SIGNUP_BONUS,
        source: "admin.create",
        expiresAt: signupBonusExpiresAt(new Date()),
      },
      tx
    )
  }

  /** 系统初始密码：只来自环境变量 DEFAULT_USER_PASSWORD，未配置即报错（不在代码里留任何兜底） */
  private get defaultPassword(): string {
    const pw = this.config.get<string>("DEFAULT_USER_PASSWORD")?.trim()
    if (!pw) {
      throw new InternalServerErrorException("系统未配置初始密码（环境变量 DEFAULT_USER_PASSWORD）")
    }
    return pw
  }

  /** 分页 + 关键词 + 组织/等级/邀请状态/企业归属筛选；返回列补会员视图（手机号脱敏） */
  async list(query: QueryUserDto): Promise<UserListDto> {
    const { page, pageSize, keyword, orgId, level, invited, teamId, hasTeam, canInvite } = query
    const skip = (page - 1) * pageSize

    // 「占用中企业归属」成员条件（ACTIVE/DISABLED 成员行 + ACTIVE/GRACE 团队），hasTeam 与展示口径一致
    const occupiedMembership: Prisma.TeamMemberWhereInput = {
      status: { in: ["ACTIVE", "DISABLED"] },
      team: { status: { in: [TeamStatus.ACTIVE, TeamStatus.GRACE] } },
    }

    const where: Prisma.UserWhereInput = {
      ...(keyword && {
        OR: [{ username: { contains: keyword } }, { phone: { contains: keyword } }],
      }),
      ...(orgId !== undefined && { orgs: { some: { orgId } } }),
      // 等级：NONE/LV1-3 按订阅档；TEAM/CUSTOM_TEAM 按企业归属（ACTIVE 成员 + 占用中团队）
      ...(level === "NONE" && { subscriptionTier: null }),
      ...(level &&
        ["LV1", "LV2", "LV3"].includes(level) && {
          subscriptionTier: Number(level.slice(2)),
        }),
      ...(level === "TEAM" && {
        teamMemberships: {
          some: { status: "ACTIVE", team: { source: "SELF", status: { in: ["ACTIVE", "GRACE"] } } },
        },
      }),
      ...(level === "CUSTOM_TEAM" && {
        teamMemberships: {
          some: {
            status: "ACTIVE",
            team: { source: "CUSTOM", status: { in: ["ACTIVE", "GRACE"] } },
          },
        },
      }),
      ...(invited === "true" && { invitedById: { not: null } }),
      ...(invited === "false" && { invitedById: null }),
      ...(canInvite === "true" && { canInvite: true }),
      ...(canInvite === "false" && { canInvite: false }),
      ...(teamId !== undefined && { teamMemberships: { some: { teamId, status: "ACTIVE" } } }),
      ...(hasTeam === "true" && { teamMemberships: { some: occupiedMembership } }),
      ...(hasTeam === "false" && { teamMemberships: { none: occupiedMembership } }),
    }

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: USER_ITEM_SELECT,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ])

    const pointsByUser = await this.pointsByUsers(rows.map(r => r.id))
    // 一级下级数（关闭分销代理的二次确认展示「名下已有 N 位一级下级」用；本页 id 一次 groupBy）
    const invitedCounts = rows.length
      ? await this.prisma.user.groupBy({
          by: ["invitedById"],
          where: { invitedById: { in: rows.map(r => r.id) } },
          _count: { _all: true },
        })
      : []
    const invitedCountBy = new Map(invitedCounts.map(c => [c.invitedById, c._count._all]))
    return {
      items: rows.map(r =>
        this.toUserItem(r, pointsByUser.get(r.id)?.toString() ?? "0", invitedCountBy.get(r.id) ?? 0)
      ),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  async getUser(id: number): Promise<UserItemDto> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: USER_ITEM_SELECT })
    if (!user) throw new NotFoundException("用户不存在")
    const [points, invitedCount] = await Promise.all([
      this.credit.getConsumableBalance(id),
      this.prisma.user.count({ where: { invitedById: id } }),
    ])
    return this.toUserItem(user, points.toString(), invitedCount)
  }

  /**
   * 查看用户手机号全号（management.users）。敏感操作：每次查看写一条 History 审计
   * （type=ADMIN_ACTION，操作人=userId）。列表/详情永不返回明文。
   */
  async getFullPhone(id: number, operatorId: number): Promise<{ phone: string }> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { phone: true } })
    if (!user) throw new NotFoundException("用户不存在")
    await this.prisma.history.create({
      data: {
        title: `查看用户 #${id} 手机号全号`,
        type: HistoryType.ADMIN_ACTION,
        data: { action: "user.phone.view", targetUserId: id, operatorId },
        userId: operatorId,
      },
    })
    this.logger.log(`user phone view: operator=${operatorId} target=${id}`)
    return { phone: user.phone }
  }

  /** 可分配的角色选项（用户表单下拉用，只读简要，无需 management.roles 权限） */
  async listRoleOptions(): Promise<RoleOptionDto[]> {
    const rows = await this.prisma.roleModel.findMany({
      select: { id: true, name: true, color: true },
      orderBy: { id: "asc" },
    })
    return rows.map(r => ({ id: r.id, name: r.name, color: r.color }))
  }

  /** 新建用户 */
  async createUser(dto: CreateUserDto): Promise<UserItemDto> {
    await this.assertPhoneAvailable(dto.phone)
    await this.assertRolesExist(dto.roleIds)
    await this.assertOrgsExist(dto.orgIds)

    // 统一发系统初始密码，首次登录强制改密
    const password = await argon2.hash(this.defaultPassword)
    const user = await this.prisma.$transaction(async tx => {
      const created = await tx.user.create({
        data: {
          username: dto.username,
          phone: dto.phone,
          password,
          mustChangePassword: true,
          roles: { create: (dto.roleIds ?? []).map(roleId => ({ roleId })) },
          orgs: { create: (dto.orgIds ?? []).map(orgId => ({ orgId })) },
        },
        select: { id: true },
      })
      await this.grantSignupBonus(created.id, tx) // 后台建号同样送 200 积分
      return created
    })
    this.logger.log(`User created: ${dto.phone} (#${user.id})`)
    return this.getUser(user.id)
  }

  /**
   * 批量新建用户：全有或全无（事务原子）。任一条失败则整批回滚。
   * 校验顺序：① 入参内部手机号查重 → ② 与库内手机号冲突 → ③ 角色/组织 id 存在 → ④ 事务内逐条创建。
   */
  async batchCreate(dto: BatchCreateUserDto): Promise<UserItemDto[]> {
    const phones = dto.users.map(u => u.phone)

    // ① 入参内部手机号重复
    const dupSet = new Set<string>()
    const dups = new Set<string>()
    for (const p of phones) {
      if (dupSet.has(p)) dups.add(p)
      dupSet.add(p)
    }
    if (dups.size) {
      throw new BadRequestException(`名单内手机号重复：${[...dups].join("、")}`)
    }

    // ② 与库内已有手机号冲突
    const existing = await this.prisma.user.findMany({
      where: { phone: { in: phones } },
      select: { phone: true },
    })
    if (existing.length) {
      throw new ConflictException(`手机号已被使用：${existing.map(e => e.phone).join("、")}`)
    }

    // ③ 校验所有角色/组织 id 存在
    await this.assertRolesExist([...new Set(dto.users.flatMap(u => u.roleIds ?? []))])
    await this.assertOrgsExist([...new Set(dto.users.flatMap(u => u.orgIds ?? []))])

    // ④ 统一发系统初始密码（逐用户独立 hash），事务内逐条创建
    const initial = this.defaultPassword
    const hashed = await Promise.all(dto.users.map(() => argon2.hash(initial)))
    const ids = await this.prisma.$transaction(async tx => {
      const out: number[] = []
      for (let i = 0; i < dto.users.length; i++) {
        const u = dto.users[i]
        const created = await tx.user.create({
          data: {
            username: u.username,
            phone: u.phone,
            password: hashed[i],
            mustChangePassword: true,
            roles: { create: (u.roleIds ?? []).map(roleId => ({ roleId })) },
            orgs: { create: (u.orgIds ?? []).map(orgId => ({ orgId })) },
          },
          select: { id: true },
        })
        await this.grantSignupBonus(created.id, tx) // 后台批量建号同样送 200 积分
        out.push(created.id)
      }
      return out
    })

    this.logger.log(`Batch created ${ids.length} users`)
    return Promise.all(ids.map(id => this.getUser(id)))
  }

  /** 修改用户：username / phone / roleIds / orgIds（后两者传入即整组覆盖） */
  async updateUser(id: number, dto: UpdateUserDto): Promise<UserItemDto> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, phone: true },
    })
    if (!user) throw new NotFoundException("用户不存在")
    if (dto.phone !== undefined && dto.phone !== user.phone) {
      await this.assertPhoneAvailable(dto.phone)
    }
    await this.assertRolesExist(dto.roleIds)
    await this.assertOrgsExist(dto.orgIds)

    const ops: Prisma.PrismaPromise<unknown>[] = []
    const scalar: Prisma.UserUpdateInput = {}
    if (dto.username !== undefined) scalar.username = dto.username
    if (dto.phone !== undefined) scalar.phone = dto.phone
    if (Object.keys(scalar).length) {
      ops.push(this.prisma.user.update({ where: { id }, data: scalar }))
    }
    if (dto.roleIds !== undefined) {
      ops.push(this.prisma.userRole.deleteMany({ where: { userId: id } }))
      if (dto.roleIds.length) {
        ops.push(
          this.prisma.userRole.createMany({
            data: dto.roleIds.map(roleId => ({ userId: id, roleId })),
            skipDuplicates: true,
          })
        )
      }
    }
    if (dto.orgIds !== undefined) {
      ops.push(this.prisma.userOrganization.deleteMany({ where: { userId: id } }))
      if (dto.orgIds.length) {
        ops.push(
          this.prisma.userOrganization.createMany({
            data: dto.orgIds.map(orgId => ({ userId: id, orgId })),
            skipDuplicates: true,
          })
        )
      }
    }
    if (ops.length) await this.prisma.$transaction(ops)

    return this.getUser(id)
  }

  /**
   * 重置密码为默认密码：标记首次登录强制改密 + 短信通知用户本人（不向管理员返回明文）。
   */
  async resetPassword(id: number): Promise<{ id: number }> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, phone: true },
    })
    if (!user) throw new NotFoundException("用户不存在")
    const password = await argon2.hash(this.defaultPassword)
    await this.prisma.user.update({
      where: { id },
      data: { password, mustChangePassword: true },
    })
    await this.smsService.sendPasswordResetNotice(user.phone)
    this.logger.log(`User password reset: #${id}`)
    return { id }
  }

  /** 停用 / 启用 */
  async setStatus(id: number, isActive: boolean): Promise<UserItemDto> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } })
    if (!user) throw new NotFoundException("用户不存在")
    await this.prisma.user.update({
      where: { id },
      data: { isActive, deactivatedAt: isActive ? null : new Date() },
    })
    return this.getUser(id)
  }

  /**
   * 批量把用户挂到目标组织。
   * - replace=false（默认）：加入，保留用户原有其他组织（幂等）
   * - replace=true：替换，用户仅保留该目标组织
   */
  async moveToOrg(dto: MoveOrgDto): Promise<{ moved: number }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: dto.orgId },
      select: { id: true },
    })
    if (!org) throw new NotFoundException("目标组织不存在")

    const data = dto.userIds.map(userId => ({ userId, orgId: dto.orgId }))

    if (dto.replace) {
      await this.prisma.$transaction([
        this.prisma.userOrganization.deleteMany({ where: { userId: { in: dto.userIds } } }),
        this.prisma.userOrganization.createMany({ data, skipDuplicates: true }),
      ])
      return { moved: dto.userIds.length }
    }

    const result = await this.prisma.userOrganization.createMany({ data, skipDuplicates: true })
    return { moved: result.count }
  }

  // ── 内部工具 ──────────────────────────────────────────────

  /** 各用户可消费积分余额（个人批次 teamId=null，RECHARGE+PACKAGE+GIFT，ACTIVE 未过期） */
  private async pointsByUsers(userIds: number[]): Promise<Map<number, Prisma.Decimal>> {
    const map = new Map<number, Prisma.Decimal>()
    if (!userIds.length) return map
    const grouped = await this.prisma.creditLot.groupBy({
      by: ["userId"],
      where: {
        userId: { in: userIds },
        teamId: null,
        bucket: { in: [CreditBucket.RECHARGE, CreditBucket.PACKAGE, CreditBucket.GIFT] },
        status: CreditLotStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      _sum: { remaining: true },
    })
    for (const g of grouped) map.set(g.userId, g._sum.remaining ?? new Prisma.Decimal(0))
    return map
  }

  private toUserItem(row: UserItemRow, points: string, invitedCount = 0): UserItemDto {
    // 占用中（ACTIVE/GRACE）企业唯一归属：取第一个命中；归档/停用企业不算归属。
    // 停用（DISABLED）成员席位仍占着、个人套餐已终止 → 仍返回归属并带 memberStatus，前端标「已停用」
    const occupied = row.teamMemberships.find(m => ["ACTIVE", "GRACE"].includes(m.team.status))
    return {
      id: row.id,
      username: row.username,
      phone: maskPhone(row.phone), // 默认脱敏；全号走 GET /users/:id/phone（写审计）
      roles: row.roles.map(r => ({
        id: r.role.id,
        code: r.role.code,
        name: r.role.name,
        color: r.role.color,
      })),
      orgs: row.orgs.map(o => ({ id: o.org.id, name: o.org.name })),
      isActive: row.isActive,
      lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      level: row.membershipLevel,
      subscriptionTier: row.subscriptionTier,
      canInvite: row.canInvite,
      rebateEnabled: row.rebateEnabled,
      rebateRate: row.rebateRate.toString(), // 一级返佣比例（「团队长 · 返佣 30%」展示用）
      invitedCount, // 一级下级数（关闭分销代理二次确认「名下已有 N 位一级下级」用）
      invitedBy: row.invitedBy ? { id: row.invitedBy.id, username: row.invitedBy.username } : null,
      team: occupied
        ? {
            id: occupied.team.id,
            name: occupied.team.name,
            source: occupied.team.source,
            role: occupied.role,
            memberStatus: occupied.status,
          }
        : null,
      points,
    }
  }

  private async assertPhoneAvailable(phone: string): Promise<void> {
    const exists = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } })
    if (exists) throw new ConflictException(`手机号 ${phone} 已被使用`)
  }

  private async assertRolesExist(roleIds: number[] | undefined): Promise<void> {
    if (!roleIds?.length) return
    const count = await this.prisma.roleModel.count({ where: { id: { in: roleIds } } })
    if (count !== new Set(roleIds).size) throw new BadRequestException("包含不存在的角色 id")
  }

  private async assertOrgsExist(orgIds: number[] | undefined): Promise<void> {
    if (!orgIds?.length) return
    const count = await this.prisma.organization.count({ where: { id: { in: orgIds } } })
    if (count !== new Set(orgIds).size) throw new BadRequestException("包含不存在的组织 id")
  }
}
