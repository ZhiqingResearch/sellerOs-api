/**
 * 邀请关系 → 企业团队迁移。邀请人当管理员，直属被邀请人当成员，invitedById 保留。
 * 跳过停用、已归属 ACTIVE/GRACE 企业、套餐积分未用完、个人订阅有效或存在待生效套餐的账号。
 * 纯 GIFT 赠送积分允许入队，金额、到期时间和个人归属原样保留，不清零、不注入企业池。
 * CUSTOM 团队：池初始 0、席位=管理员+可迁移成员、折扣继承管理员生效折扣，默认 365 天。
 * 管理员个人 RECHARGE 正净额注入共享池，成员个人充值不动；建队与注入一起提交。
 * 管理员欠账不清除、不转入池；充值净额≤0 时不注入，仍可建队。待生效套餐不取消。
 * 事务内锁用户并复核权益，充值批次锁定后转移；失败返回非零退出码，可重跑核对/补注入。
 * 数据库死锁/锁等待超时仅在整笔事务回滚后有限重试，最多 3 次。
 * 已有迁移团队只补注入，不重建、不自动补拉之前跳过的成员。
 * 不启动 Nest 应用上下文，避免启动钩子产生数据库写入；dry-run 全程只读。
 *
 * npx tsx scripts/migrate-invitees-to-team.ts --phone 13800000000 --dry-run
 * npx tsx scripts/migrate-invitees-to-team.ts --phone 13800000000
 * npx tsx scripts/migrate-invitees-to-team.ts --all --dry-run
 *
 * 环境变量：TEAM_DAYS（正整数，默认 365），DATABASE_URL 决定目标库，启动时打印。
 */

import {
  CreditBucket,
  CreditDirection,
  CreditLotStatus,
  CreditTxnType,
  MembershipLevel,
  Prisma,
  ScheduledPlanStatus,
  TeamRole,
  TeamSource,
  TeamStatus,
} from "@prisma/client"
import "dotenv/config"
import { CreditService } from "../src/membership/credit.service"
import { DAY_MS } from "../src/membership/membership.constants"
import { PrismaService } from "../src/prisma/prisma.service"
import { dataKeepUntilOf, graceUntilOf, TeamAuditAction } from "../src/team/team.constants"

/** 历史迁移标记，保持不变以识别已有团队。 */
const CONTRACT_NOTE = "邀请关系迁移（scripts/migrate-invitees-to-team.ts）"
const TRANSFER_OPTIONS = {
  source: "migrate.invitees-to-team",
  meta: { script: "scripts/migrate-invitees-to-team.ts" },
}
type Tx = Prisma.TransactionClient
type RechargeTransfer = { amount: Prisma.Decimal; personalNet: Prisma.Decimal }

export interface MigrationArgs {
  phone?: string
  all: boolean
  dryRun: boolean
}

type UserRow = {
  id: number
  username: string
  phone: string
  isActive: boolean
  canInvite: boolean
  discount: Prisma.Decimal
  invitedById: number | null
  subscriptionTier: number | null
  subscriptionExpiresAt: Date | null
}

const USER_SELECT = {
  id: true,
  username: true,
  phone: true,
  isActive: true,
  canInvite: true,
  discount: true,
  invitedById: true,
  subscriptionTier: true,
  subscriptionExpiresAt: true,
} as const

export function parseArgs(args = process.argv.slice(2)): MigrationArgs {
  let phone: string | undefined
  let all = false
  let dryRun = false
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!["--phone", "--all", "--dry-run"].includes(arg)) {
      throw new Error(`未知参数：${arg}（仅支持 --phone、--all、--dry-run）`)
    }
    if (seen.has(arg)) throw new Error(`参数重复：${arg}`)
    seen.add(arg)
    if (arg === "--phone") {
      const value = args[++i]?.trim()
      if (!value || value.startsWith("-")) throw new Error("--phone 后需要跟手机号")
      phone = value
    } else if (arg === "--all") {
      all = true
    } else {
      dryRun = true
    }
  }
  if (phone && all) throw new Error("--phone 与 --all 不可同时使用")
  if (!phone && !all) {
    throw new Error("必须指定范围：--phone <邀请人手机号> 或 --all（防止误全量）")
  }
  return { phone, all, dryRun }
}

export function parseTeamDays(value = process.env.TEAM_DAYS ?? "365"): number {
  const days = Number(value)
  const retentionEnd = new Date(Date.now() + (days + 60) * DAY_MS)
  if (
    !Number.isSafeInteger(days) ||
    days <= 0 ||
    !Number.isFinite(retentionEnd.getTime()) ||
    retentionEnd.getUTCFullYear() > 9999
  ) {
    throw new Error(`TEAM_DAYS 非法：${value}（应为有效的正整数天数）`)
  }
  return days
}

function targetLabel(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "")
    return `${u.host}${u.pathname}`
  } catch {
    return "（DATABASE_URL 解析失败）"
  }
}

function maskPhone(phone: string): string {
  return phone.replace(/^(\d{3})\d+(\d{4})$/, "$1****$2")
}

/** 仅重试数据库明确报告的事务冲突；业务拒绝、连接/提交结果不明等错误直接返回。 */
async function migrationTransaction<T>(
  prisma: PrismaService,
  run: (tx: Tx) => Promise<T>,
  timeout: number
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(run, {
        timeout,
        maxWait: 20_000,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      })
    } catch (error) {
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" ||
          (error.code === "P2010" && ["1213", "1205"].includes(String(error.meta?.code))))
      if (!retryable || attempt >= 2) throw error
      console.warn(`  数据库并发冲突，正在重试（第 ${attempt + 2}/3 次）`)
      await new Promise<void>(resolve => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }
}

async function skipReason(
  prisma: PrismaService | Tx,
  credit: CreditService,
  user: UserRow,
  claimed: Set<number>
): Promise<string | null> {
  if (!user.isActive) return "账号已停用"
  if (claimed.has(user.id)) return "本轮已被前序邀请人的企业占用"
  const occupied = await prisma.teamMember.findFirst({
    where: {
      userId: user.id,
      status: "ACTIVE",
      team: { status: { in: [TeamStatus.ACTIVE, TeamStatus.GRACE] } },
    },
    select: { teamId: true },
  })
  if (occupied) return `已归属企业 teamId=${occupied.teamId}`
  const packageBalance = await credit.consumableBalance(prisma, user.id, [CreditBucket.PACKAGE])
  if (packageBalance.greaterThan(0)) {
    return `套餐积分未用完（剩余 ${packageBalance.toString()}）`
  }
  if (
    user.subscriptionTier != null &&
    user.subscriptionExpiresAt &&
    user.subscriptionExpiresAt > new Date()
  ) {
    return `个人订阅仍在有效期（至 ${user.subscriptionExpiresAt.toISOString().slice(0, 10)}）`
  }
  const pending = await prisma.scheduledPlan.findFirst({
    where: { userId: user.id, teamId: null, status: ScheduledPlanStatus.PENDING },
    select: { id: true },
  })
  if (pending) return `存在待生效个人套餐（续费单 #${pending.id}），请先处理套餐权益`
  return null
}

async function transferAdminRecharge(
  tx: Tx,
  credit: CreditService,
  userId: number,
  teamId: number
): Promise<RechargeTransfer> {
  // 锁住目标团队，避免核对状态后恰好被归档，导致积分注入已归档的池。
  await tx.$queryRaw`SELECT id FROM Team WHERE id = ${teamId} FOR UPDATE`
  const target = await tx.team.findFirst({
    where: {
      id: teamId,
      adminId: userId,
      contractNote: CONTRACT_NOTE,
      status: { in: [TeamStatus.ACTIVE, TeamStatus.GRACE] },
    },
    select: { id: true },
  })
  if (!target) throw new Error("迁移团队状态或管理员已变更，不可注入")
  // 当前读锁定全部匹配批次（含欠账），只从有效正批次转出净额，负批次保留个人归属。
  const lots = await tx.$queryRaw<
    Array<{ id: number; remaining: Prisma.Decimal; expiresAt: Date | null }>
  >`
    SELECT id, remaining, expiresAt FROM CreditLot
    WHERE userId = ${userId}
      AND teamId IS NULL
      AND bucket = ${CreditBucket.RECHARGE}
      AND status = ${CreditLotStatus.ACTIVE}
    ORDER BY id FOR UPDATE
  `
  const now = new Date()
  const eligible = lots.filter(lot => !lot.expiresAt || lot.expiresAt > now)
  const balance = eligible.reduce((sum, lot) => sum.plus(lot.remaining), new Prisma.Decimal(0))
  if (!balance.greaterThan(0)) return { amount: new Prisma.Decimal(0), personalNet: balance }
  let left = balance
  for (const lot of eligible) {
    if (!left.greaterThan(0)) break
    if (!lot.remaining.greaterThan(0)) continue
    const take = Prisma.Decimal.min(lot.remaining, left)
    const remaining = lot.remaining.minus(take)
    await tx.creditLot.update({
      where: { id: lot.id },
      data: {
        remaining,
        status: remaining.isZero() ? CreditLotStatus.EXHAUSTED : CreditLotStatus.ACTIVE,
      },
    })
    left = left.minus(take)
  }
  if (!left.isZero()) throw new Error("充值积分净额与可转出批次不一致，迁移已中止")
  await tx.creditTransaction.create({
    data: {
      userId,
      direction: CreditDirection.DEBIT,
      bucket: CreditBucket.RECHARGE,
      type: CreditTxnType.MANUAL_ADJUST,
      amount: balance,
      balanceAfter: await credit.consumableBalance(tx, userId),
      source: TRANSFER_OPTIONS.source,
      meta: { ...TRANSFER_OPTIONS.meta, injectToTeamId: teamId },
    },
  })
  await credit.recordRecharge(
    userId,
    {
      type: CreditTxnType.TEAM_RECHARGE,
      source: TRANSFER_OPTIONS.source,
      lots: [{ bucket: CreditBucket.RECHARGE, amount: balance, expiresAt: null }],
      teamId,
      meta: { ...TRANSFER_OPTIONS.meta, injectedFromPersonal: true },
    },
    tx
  )
  return { amount: balance, personalNet: new Prisma.Decimal(0) }
}

function transferredLabel({ amount, personalNet }: RechargeTransfer): string {
  if (amount.greaterThan(0)) return `管理员个人充值净额 ${amount.toString()} 积分已转入企业池`
  return personalNet.lessThan(0)
    ? `管理员个人充值净额 ${personalNet.toString()}，欠账保留个人账户，本次不注入企业池`
    : "管理员无可注入个人充值存量"
}

async function injectAdminRecharge(
  prisma: PrismaService,
  credit: CreditService,
  inviter: UserRow,
  teamId: number,
  dryRun: boolean
): Promise<string> {
  if (dryRun) {
    const amount = await credit.consumableBalance(prisma, inviter.id, [CreditBucket.RECHARGE])
    return amount.greaterThan(0)
      ? `管理员个人充值净额 ${amount.toString()} 积分将注入企业池`
      : transferredLabel({ amount: new Prisma.Decimal(0), personalNet: amount })
  }
  const amount = await migrationTransaction(
    prisma,
    async tx => {
      await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${inviter.id} FOR UPDATE`
      return transferAdminRecharge(tx, credit, inviter.id, teamId)
    },
    60_000
  )
  return transferredLabel(amount)
}

/** 本脚本独立持有事务，按平台定制建队的字段/审计口径写入，无需改变线上服务。 */
async function createMigratedTeam(
  tx: Tx,
  credit: CreditService,
  inviterId: number,
  memberIds: number[],
  teamDays: number
) {
  const userIds = [...new Set([inviterId, ...memberIds])]
  await tx.$queryRaw`
    SELECT id FROM \`User\`
    WHERE id IN (${Prisma.join([...userIds].sort((a, b) => a - b))})
    ORDER BY id FOR UPDATE
  `
  // 锁后重查迁移标记，两个脚本同时处理同一邀请人时复用首次建好的团队。
  const existing = await tx.team.findFirst({
    where: {
      adminId: inviterId,
      contractNote: CONTRACT_NOTE,
      status: { in: [TeamStatus.ACTIVE, TeamStatus.GRACE] },
    },
    select: { id: true },
  })
  if (existing) {
    const transferred = await transferAdminRecharge(tx, credit, inviterId, existing.id)
    return { created: false as const, teamId: existing.id, transferred }
  }

  const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: USER_SELECT })
  const admin = users.find(user => user.id === inviterId)
  if (!admin || users.length !== userIds.length) throw new Error("迁移账号已变更或不存在")
  for (const user of users) {
    const reason = await skipReason(tx, credit, user, new Set<number>())
    if (reason) throw new Error(`用户 #${user.id} 不可迁移：${reason}`)
    if (user.id !== inviterId && user.invitedById !== inviterId) {
      throw new Error(`用户 #${user.id} 邀请关系已变更，不可迁移`)
    }
  }
  const discount = await credit.resolveEffectiveDiscount(tx, admin)
  const expiresAt = new Date(Date.now() + teamDays * DAY_MS)
  const team = await tx.team.create({
    data: {
      name: null,
      nameFilled: false,
      source: TeamSource.CUSTOM,
      status: TeamStatus.ACTIVE,
      seats: userIds.length,
      adminId: inviterId,
      invitedById: admin.invitedById,
      discount,
      expiresAt,
      graceUntil: graceUntilOf(expiresAt),
      dataKeepUntil: dataKeepUntilOf(expiresAt),
      contractNote: CONTRACT_NOTE,
    },
  })
  for (const userId of userIds) {
    // 锁后确认无有效个人套餐，不调用强制清零，个人赠送积分及其到期时间原样保留。
    await tx.user.update({
      where: { id: userId },
      data: {
        subscriptionTier: null,
        membershipLevel: MembershipLevel.NONE,
        subscriptionExpiresAt: null,
      },
    })
    const role = userId === inviterId ? TeamRole.ADMIN : TeamRole.MEMBER
    await tx.teamMember.upsert({
      where: { teamId_userId: { teamId: team.id, userId } },
      create: { teamId: team.id, userId, role, status: "ACTIVE", joinedAt: new Date() },
      update: {
        role,
        status: "ACTIVE",
        joinedAt: new Date(),
        monthlyQuota: null,
        quotaUsedThisMonth: 0,
        quotaMonth: null,
      },
    })
  }
  await tx.teamAuditLog.create({
    data: {
      teamId: team.id,
      actorId: 0,
      action: TeamAuditAction.TEAM_CREATE,
      meta: {
        name: null,
        seats: userIds.length,
        expiresAt: expiresAt.toISOString(),
        poolPackageCredits: 0,
        poolRechargeCredits: 0,
        discount: Number(discount.toString()),
        contractAmountCny: null,
        contractNote: CONTRACT_NOTE,
        adminUserId: inviterId,
        memberIds: userIds,
      },
    },
  })
  const transferred = await transferAdminRecharge(tx, credit, inviterId, team.id)
  return { created: true as const, teamId: team.id, transferred, discount, expiresAt }
}

/** 可注入服务进行隔离测试；不连接/关闭数据库，不触发 Nest 启动钩子。 */
export async function runMigration(
  prisma: PrismaService,
  credit: CreditService,
  { phone, dryRun }: MigrationArgs,
  teamDays: number
) {
  const stats = {
    created: 0,
    planned: 0,
    inviterSkipped: 0,
    memberJoined: 0,
    memberSkipped: 0,
    failed: 0,
  }
  const claimed = new Set<number>()
  const inviters: UserRow[] = phone
    ? await prisma.user.findMany({ where: { phone }, select: USER_SELECT })
    : await prisma.user.findMany({
        where: { invitees: { some: {} } },
        select: USER_SELECT,
        orderBy: { id: "asc" },
      })
  if (!inviters.length) {
    if (phone) throw new Error(`未找到邀请人账号（手机 ${maskPhone(phone)}）`)
    console.log("没有找到任何名下有被邀请人的邀请人")
    return stats
  }

  for (const inviter of inviters) {
    console.log(`\n邀请人 ${inviter.username}(#${inviter.id}, ${maskPhone(inviter.phone)})`)
    try {
      const ownTeam = await prisma.team.findFirst({
        where: {
          adminId: inviter.id,
          contractNote: CONTRACT_NOTE,
          status: { in: [TeamStatus.ACTIVE, TeamStatus.GRACE] },
        },
        select: { id: true },
      })
      if (ownTeam) {
        const msg = await injectAdminRecharge(prisma, credit, inviter, ownTeam.id, dryRun)
        console.log(`  已迁移过 teamId=${ownTeam.id}；${msg}`)
        stats.inviterSkipped++
        continue
      }

      const reason = await skipReason(prisma, credit, inviter, claimed)
      if (reason) {
        console.log(`  跳过建队：${reason}`)
        stats.inviterSkipped++
        continue
      }
      const invitees: UserRow[] = await prisma.user.findMany({
        where: { invitedById: inviter.id },
        select: USER_SELECT,
        orderBy: { id: "asc" },
      })
      const joinable: UserRow[] = []
      for (const member of invitees) {
        const memberReason = await skipReason(prisma, credit, member, claimed)
        if (memberReason) {
          console.log(
            `  成员跳过：${member.username}(#${member.id}, ${maskPhone(member.phone)}) —— ${memberReason}`
          )
          stats.memberSkipped++
        } else {
          joinable.push(member)
        }
      }
      if (!joinable.length) {
        console.log("  未建队：无可拉入的被邀请人")
        stats.inviterSkipped++
        continue
      }

      const seats = 1 + joinable.length
      const memberLabel = joinable.map(member => `${member.username}(#${member.id})`).join("、")
      const discount = await credit.resolveEffectiveDiscount(prisma, inviter)
      if (dryRun) {
        const plan = await injectAdminRecharge(prisma, credit, inviter, -1, true)
        console.log(
          `  将建队：席位=${seats} 有效期=${teamDays} 天 池折扣=${discount.toString()}，成员=${memberLabel}；${plan}`
        )
        stats.planned++
      } else {
        const result = await migrationTransaction(
          prisma,
          tx =>
            createMigratedTeam(
              tx,
              credit,
              inviter.id,
              joinable.map(member => member.id),
              teamDays
            ),
          180_000
        )
        if (!result.created) {
          stats.inviterSkipped++
          console.log(`  已迁移过 teamId=${result.teamId}；${transferredLabel(result.transferred)}`)
          continue
        }
        stats.created++
        console.log(
          `  已建队 teamId=${result.teamId}：席位=${seats} 到期=${result.expiresAt.toISOString().slice(0, 10)} ` +
            `池折扣=${result.discount.toString()} 成员=${memberLabel}；${transferredLabel(result.transferred)}`
        )
      }
      claimed.add(inviter.id)
      joinable.forEach(member => claimed.add(member.id))
      stats.memberJoined += joinable.length
    } catch (error) {
      stats.failed++
      console.error(
        `  迁移未确认成功（#${inviter.id}）：${error instanceof Error ? error.message : String(error)} —— 请重跑核对`
      )
    }
  }

  console.log(
    `\n汇总：建队 ${stats.created}（dry-run 计划 ${stats.planned}），邀请人跳过 ${stats.inviterSkipped}，` +
      `成员拉入 ${stats.memberJoined}，成员跳过 ${stats.memberSkipped}，失败 ${stats.failed}`
  )
  if (stats.failed)
    throw new Error(`有 ${stats.failed} 个邀请人迁移或补注入失败，请根据报告重跑核对`)
  return stats
}

async function main() {
  // 参数校验先于连接，拼写错误不能触发任何数据库操作。
  const args = parseArgs()
  const days = parseTeamDays()
  console.log(`目标库: ${targetLabel()}${args.dryRun ? "　【DRY-RUN 只出报告不落库】" : ""}`)
  const prisma = new PrismaService()
  try {
    await prisma.$connect()
    const credit = new CreditService(prisma)
    await runMigration(prisma, credit, args, days)
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error("失败:", error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
