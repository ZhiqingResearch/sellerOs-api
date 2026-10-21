/**
 * 一次性修正：将本地名单指定用户升级为 LV5，并把多种当前状态的用户统一迁移为其 LV4 下级。
 *
 * 用法：
 *   npx ts-node scripts/reassign-invite-relations-20260724.ts --dry-run   # 预览，不写库
 *   npx ts-node scripts/reassign-invite-relations-20260724.ts             # 实际执行
 *
 * 保护：
 *   - 名单从 scripts/data/invite-relations.data.ts 读取，该目录不提交。
 *   - 仅按手机号匹配，姓名只用于日志核对。
 *   - 逐人校验预期原邀请人；仅名单明确允许的 LV5 可以降为 LV4。
 *   - LV5 降级前必须保持指定的下级人数，避免遗留下级关系。
 *   - 目标 LV4 查无账号时打印并跳过，不影响其余用户。
 *   - 正式执行使用单事务；任一校验失败则不写入。
 *   - 已完成后可重复运行，不重复清零赠送积分或更换邀请码。
 */
import {
  CreditBucket,
  CreditDirection,
  CreditLotStatus,
  CreditTxnType,
  MembershipLevel,
  Prisma,
  PrismaClient,
} from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { createRequire } from "node:module"

const prisma = new PrismaClient()

const CODE_TTL_MS = 24 * 60 * 60 * 1000
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

interface InviteUser {
  name: string
  phone: string
}

interface NewInviter extends InviteUser {
  expectedInviterPhone?: string | null
}

interface TargetInvitee extends InviteUser {
  expectedInviterPhone?: string | null
  allowDemoteFromInviter?: boolean
  expectedInviteeCount?: number
}

interface InviteRelationReassignment {
  newInviter: NewInviter
  targetInvitees: TargetInvitee[]
}

type Tx = Prisma.TransactionClient
type UserSnapshot = {
  id: number
  username: string
  phone: string
  canInvite: boolean
  membershipLevel: MembershipLevel
  invitedById: number | null
  invitedBy: { id: number; phone: string } | null
  inviteCode: string | null
  inviteCodeExpiresAt: Date | null
  discount: Decimal
  _count: { invitees: number }
}

type MigrationPlan = {
  newInviter: UserSnapshot
  needPromoteNewInviter: boolean
  inviteesToUpdate: Array<{ config: TargetInvitee; user: UserSnapshot }>
  missingInvitees: TargetInvitee[]
  alreadyDoneCount: number
}

function loadReassignment(): InviteRelationReassignment {
  try {
    const requireData = createRequire(__filename)
    const data = requireData("./data/invite-relations.data") as {
      INVITE_RELATION_REASSIGNMENT_20260724?: InviteRelationReassignment
    }
    if (!data.INVITE_RELATION_REASSIGNMENT_20260724) {
      throw new Error("INVITE_RELATION_REASSIGNMENT_20260724 未定义")
    }
    return data.INVITE_RELATION_REASSIGNMENT_20260724
  } catch (e) {
    const cause = e instanceof Error ? `：${e.message}` : ""
    throw new Error(`缺少或无法读取本地名单文件 scripts/data/invite-relations.data.ts${cause}`)
  }
}

function normalizePhone(phone: string) {
  return phone
    .trim()
    .replace(/^\+?86[-\s]?/, "")
    .replace(/\D/g, "")
}

function label(user: InviteUser) {
  return `${user.name}（${normalizePhone(user.phone)}）`
}

function normalizedReassignment(): InviteRelationReassignment {
  const source = loadReassignment()
  const seen = new Set<string>()
  const targetInvitees: TargetInvitee[] = []

  for (const item of source.targetInvitees) {
    const phone = normalizePhone(item.phone)
    if (seen.has(phone)) {
      console.log(`名单手机号重复，已去重：${label(item)}`)
      continue
    }
    seen.add(phone)
    targetInvitees.push({
      ...item,
      phone,
      expectedInviterPhone:
        typeof item.expectedInviterPhone === "string"
          ? normalizePhone(item.expectedInviterPhone)
          : item.expectedInviterPhone,
    })
  }

  return {
    newInviter: {
      ...source.newInviter,
      phone: normalizePhone(source.newInviter.phone),
      expectedInviterPhone:
        typeof source.newInviter.expectedInviterPhone === "string"
          ? normalizePhone(source.newInviter.expectedInviterPhone)
          : source.newInviter.expectedInviterPhone,
    },
    targetInvitees,
  }
}

const CONFIG = normalizedReassignment()

async function findUserByPhone(
  client: PrismaClient | Tx,
  phone: string
): Promise<UserSnapshot | null> {
  return client.user.findUnique({
    where: { phone: normalizePhone(phone) },
    select: {
      id: true,
      username: true,
      phone: true,
      canInvite: true,
      membershipLevel: true,
      invitedById: true,
      invitedBy: { select: { id: true, phone: true } },
      inviteCode: true,
      inviteCodeExpiresAt: true,
      discount: true,
      _count: { select: { invitees: true } },
    },
  })
}

function validateExpectedInviter(
  config: { expectedInviterPhone?: string | null },
  user: UserSnapshot,
  targetInviterId?: number
): string | null {
  if (targetInviterId != null && user.invitedById === targetInviterId) return null
  if (config.expectedInviterPhone === undefined) return null

  const actualPhone = user.invitedBy?.phone ?? null
  if (actualPhone === config.expectedInviterPhone) return null

  return `当前邀请人是 ${actualPhone ?? "无"}，预期为 ${config.expectedInviterPhone ?? "无"}`
}

async function buildPlan(client: PrismaClient | Tx): Promise<MigrationPlan> {
  const newInviter = await findUserByPhone(client, CONFIG.newInviter.phone)
  const invitees = await Promise.all(
    CONFIG.targetInvitees.map(item => findUserByPhone(client, item.phone))
  )
  const errors: string[] = []
  const missingInvitees: TargetInvitee[] = []

  if (!newInviter) {
    errors.push(`新邀请人 ${label(CONFIG.newInviter)} 查无账号`)
  } else {
    if (CONFIG.targetInvitees.some(item => item.phone === newInviter.phone)) {
      errors.push(`新邀请人 ${label(CONFIG.newInviter)} 不能同时出现在 LV4 名单中`)
    }
    if (newInviter.canInvite) {
      if (newInviter.invitedById != null) {
        errors.push(`新邀请人 ${label(CONFIG.newInviter)} 已是 LV5，但仍有上级邀请人`)
      }
    } else {
      const inviterError = validateExpectedInviter(CONFIG.newInviter, newInviter)
      if (inviterError) errors.push(`新邀请人 ${label(CONFIG.newInviter)}：${inviterError}`)
    }
  }

  CONFIG.targetInvitees.forEach((item, index) => {
    const user = invitees[index]
    if (!user) {
      missingInvitees.push(item)
      return
    }
    if (!newInviter) return

    const alreadyDone =
      !user.canInvite &&
      user.invitedById === newInviter.id &&
      user.membershipLevel === MembershipLevel.FOUNDER &&
      user.discount.equals(newInviter.discount) &&
      user.inviteCode == null &&
      user.inviteCodeExpiresAt == null
    if (alreadyDone) return

    if (user._count.invitees > 0) {
      errors.push(`目标 LV4 ${label(item)} 当前仍有 ${user._count.invitees} 个下级`)
    }

    if (user.canInvite) {
      if (!item.allowDemoteFromInviter) {
        errors.push(`目标 LV4 ${label(item)} 当前是 LV5，名单未允许降级`)
      }
      const expectedCount = item.expectedInviteeCount ?? 0
      if (user._count.invitees !== expectedCount) {
        errors.push(
          `目标 LV4 ${label(item)} 当前下级数为 ${user._count.invitees}，预期为 ${expectedCount}`
        )
      }
      if (user.invitedById != null) {
        errors.push(`目标 LV4 ${label(item)} 当前是 LV5，但仍有上级邀请人`)
      }
    } else {
      const inviterError = validateExpectedInviter(item, user, newInviter.id)
      if (inviterError) errors.push(`目标 LV4 ${label(item)}：${inviterError}`)
    }
  })

  if (errors.length) {
    throw new Error(`校验失败，未写入任何数据：\n${errors.map(e => `  - ${e}`).join("\n")}`)
  }
  if (!newInviter) throw new Error("新邀请人不存在")

  const inviteesToUpdate = CONFIG.targetInvitees
    .map((config, index) => ({ config, user: invitees[index] }))
    .filter(
      (item): item is { config: TargetInvitee; user: UserSnapshot } =>
        item.user != null &&
        (item.user.canInvite ||
          item.user.invitedById !== newInviter.id ||
          item.user.membershipLevel !== MembershipLevel.FOUNDER ||
          !item.user.discount.equals(newInviter.discount) ||
          item.user.inviteCode != null ||
          item.user.inviteCodeExpiresAt != null)
    )

  return {
    newInviter,
    needPromoteNewInviter: !newInviter.canInvite,
    inviteesToUpdate,
    missingInvitees,
    alreadyDoneCount:
      CONFIG.targetInvitees.length - inviteesToUpdate.length - missingInvitees.length,
  }
}

async function consumableBalance(tx: Tx, userId: number): Promise<Decimal> {
  const agg = await tx.creditLot.aggregate({
    where: {
      userId,
      bucket: { in: [CreditBucket.RECHARGE, CreditBucket.PACKAGE, CreditBucket.GIFT] },
      status: CreditLotStatus.ACTIVE,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    _sum: { remaining: true },
  })
  return agg._sum.remaining ?? new Decimal(0)
}

async function clearGrantedCredits(tx: Tx, userId: number): Promise<number> {
  const lots = await tx.creditLot.findMany({
    where: {
      userId,
      bucket: { in: [CreditBucket.PACKAGE, CreditBucket.GIFT] },
      status: CreditLotStatus.ACTIVE,
      remaining: { gt: 0 },
    },
  })
  for (const lot of lots) {
    await tx.creditLot.update({
      where: { id: lot.id },
      data: { remaining: 0, status: CreditLotStatus.EXPIRED },
    })
    const balanceAfter = await consumableBalance(tx, userId)
    await tx.creditTransaction.create({
      data: {
        userId,
        direction: CreditDirection.DEBIT,
        bucket: lot.bucket,
        type: CreditTxnType.EXPIRE,
        amount: lot.remaining,
        balanceAfter,
        lotId: lot.id,
        source: "invite.switch",
      },
    })
  }
  return lots.length
}

async function generateUniqueCode(tx: Tx): Promise<string> {
  for (let i = 0; i < 20; i++) {
    let code = "OS"
    for (let j = 0; j < 4; j++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    const exists = await tx.user.findUnique({ where: { inviteCode: code }, select: { id: true } })
    if (!exists) return code
  }
  throw new Error("邀请码生成失败（连续 20 次碰撞）")
}

function printPlan(plan: MigrationPlan) {
  console.log(
    `新邀请人：${CONFIG.newInviter.name}（${plan.newInviter.phone}，id=${plan.newInviter.id}）`
  )
  console.log(
    plan.needPromoteNewInviter
      ? "  [将] 解绑并升级为 LV5，清零 PACKAGE+GIFT、撤订阅、发 24h 邀请码"
      : "  已是 LV5，跳过升级"
  )
  console.log(
    `目标 LV4：[将] 更新 ${plan.inviteesToUpdate.length} 人，已完成 ${plan.alreadyDoneCount} 人，查无账号跳过 ${plan.missingInvitees.length} 人`
  )
  for (const { config, user } of plan.inviteesToUpdate) {
    const action = user.canInvite ? "LV5 降为 LV4" : "迁移为 LV4"
    console.log(`  - ${config.name}（${user.phone}，id=${user.id}）：${action}`)
  }
  for (const item of plan.missingInvitees) {
    console.log(`  - ${label(item)}：查无账号，已跳过`)
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  console.log(`=== 邀请关系迁移${dryRun ? "（DRY-RUN 预览，不写库）" : ""} ===\n`)

  const preview = await buildPlan(prisma)
  printPlan(preview)

  if (dryRun) {
    console.log("\n（DRY-RUN：未写入任何数据，去掉 --dry-run 正式执行）")
    return
  }

  await prisma.$transaction(
    async tx => {
      // 事务内重查，防止预览后账号身份或上下级关系发生变化。
      const plan = await buildPlan(tx)
      let inviteCode: string | null = null
      let cleared = 0

      if (plan.needPromoteNewInviter) {
        cleared = await clearGrantedCredits(tx, plan.newInviter.id)
        inviteCode = await generateUniqueCode(tx)
        await tx.user.update({
          where: { id: plan.newInviter.id },
          data: {
            invitedById: null,
            canInvite: true,
            subscriptionTier: null,
            subscriptionStart: null,
            subscriptionExpiresAt: null,
            membershipLevel: MembershipLevel.INVITER,
            inviteCode,
            inviteCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
          },
        })
      }

      for (const { user } of plan.inviteesToUpdate) {
        await tx.user.update({
          where: { id: user.id },
          data: {
            canInvite: false,
            invitedById: plan.newInviter.id,
            membershipLevel: MembershipLevel.FOUNDER,
            inviteCode: null,
            inviteCodeExpiresAt: null,
            discount: plan.newInviter.discount,
          },
        })
      }

      console.log(
        plan.needPromoteNewInviter
          ? `\n已升级新邀请人：清零赠送批次 ${cleared} 笔，邀请码 ${inviteCode}`
          : "\n新邀请人已是 LV5，未重复升级"
      )
      console.log(`已更新目标 LV4 ${plan.inviteesToUpdate.length} 人`)
    },
    { maxWait: 10_000, timeout: 60_000 }
  )

  console.log("=== 完成 ===")
}

main()
  .catch(e => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
  .finally(() => void prisma.$disconnect())
