/**
 * 一次性修正：批量升级指定 LV4 为 LV5，并将指定用户迁移到已有 LV5 名下。
 *
 * 用法：
 *   npx ts-node scripts/reassign-invite-relations-20260804.ts --dry-run   # 预览，不写库
 *   npx ts-node scripts/reassign-invite-relations-20260804.ts             # 实际执行
 *
 * 保护：
 *   - 名单从 scripts/data/invite-relations.data.ts 读取，该目录不提交。
 *   - 仅按手机号匹配，姓名只用于日志核对。
 *   - 升级 LV5 前校验其原邀请人；迁移 LV4 时可逐人校验原邀请人。
 *   - 不会把已有 LV5 降为 LV4，也不会覆盖存在下级的异常账号。
 *   - 正式执行使用单事务，并在事务内二次校验；任一校验失败则不写入。
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

interface PromotionTarget extends InviteUser {
  expectedInviterPhone?: string | null
}

interface InviteeTarget extends InviteUser {
  expectedInviterPhone?: string | null
}

interface InviteeGroup {
  inviter: InviteUser
  invitees: InviteeTarget[]
}

interface InviteRelationBatch {
  promotions: PromotionTarget[]
  inviteeGroups: InviteeGroup[]
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

type PromotionPlan = {
  config: PromotionTarget
  user: UserSnapshot
  needsUpdate: boolean
}

type InviteeGroupPlan = {
  config: InviteeGroup
  inviter: UserSnapshot
  inviteesToUpdate: Array<{ config: InviteeTarget; user: UserSnapshot }>
  alreadyDoneCount: number
}

type MigrationPlan = {
  promotions: PromotionPlan[]
  inviteeGroups: InviteeGroupPlan[]
}

function loadBatch(): InviteRelationBatch {
  try {
    const requireData = createRequire(__filename)
    const data = requireData("./data/invite-relations.data") as {
      INVITE_RELATION_BATCH_20260804?: InviteRelationBatch
    }
    if (!data.INVITE_RELATION_BATCH_20260804) {
      throw new Error("INVITE_RELATION_BATCH_20260804 未定义")
    }
    return data.INVITE_RELATION_BATCH_20260804
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

function normalizeExpectedPhone(phone: string | null | undefined) {
  return typeof phone === "string" ? normalizePhone(phone) : phone
}

function label(user: InviteUser) {
  return `${user.name}（${normalizePhone(user.phone)}）`
}

function normalizedBatch(): InviteRelationBatch {
  const source = loadBatch()
  return {
    promotions: source.promotions.map(item => ({
      ...item,
      phone: normalizePhone(item.phone),
      expectedInviterPhone: normalizeExpectedPhone(item.expectedInviterPhone),
    })),
    inviteeGroups: source.inviteeGroups.map(group => ({
      inviter: { ...group.inviter, phone: normalizePhone(group.inviter.phone) },
      invitees: group.invitees.map(item => ({
        ...item,
        phone: normalizePhone(item.phone),
        expectedInviterPhone: normalizeExpectedPhone(item.expectedInviterPhone),
      })),
    })),
  }
}

const CONFIG = normalizedBatch()

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
  completedInviterId?: number
) {
  if (completedInviterId != null && user.invitedById === completedInviterId) return null
  if (config.expectedInviterPhone === undefined) return null

  const actualPhone = user.invitedBy?.phone ?? null
  if (actualPhone === config.expectedInviterPhone) return null

  return `当前邀请人是 ${actualPhone ?? "无"}，预期为 ${config.expectedInviterPhone ?? "无"}`
}

function validateUniqueTargets() {
  const errors: string[] = []
  const targets = new Map<string, string>()

  const addTarget = (phone: string, description: string) => {
    const existing = targets.get(phone)
    if (existing) errors.push(`手机号 ${phone} 同时出现在“${existing}”和“${description}”`)
    else targets.set(phone, description)
  }

  for (const item of CONFIG.promotions) addTarget(item.phone, `升级 LV5：${item.name}`)
  for (const group of CONFIG.inviteeGroups) {
    addTarget(group.inviter.phone, `目标邀请人：${group.inviter.name}`)
    for (const item of group.invitees) addTarget(item.phone, `迁移 LV4：${item.name}`)
  }

  return errors
}

async function buildPlan(client: PrismaClient | Tx): Promise<MigrationPlan> {
  const errors = validateUniqueTargets()
  const promotionUsers = await Promise.all(
    CONFIG.promotions.map(item => findUserByPhone(client, item.phone))
  )
  const groupUsers = await Promise.all(
    CONFIG.inviteeGroups.map(async group => ({
      inviter: await findUserByPhone(client, group.inviter.phone),
      invitees: await Promise.all(group.invitees.map(item => findUserByPhone(client, item.phone))),
    }))
  )

  const promotions: PromotionPlan[] = []
  CONFIG.promotions.forEach((item, index) => {
    const user = promotionUsers[index]
    if (!user) {
      errors.push(`待升级 LV5 ${label(item)} 查无账号`)
      return
    }

    if (user.canInvite) {
      if (user.invitedById != null) {
        errors.push(`待升级 LV5 ${label(item)} 已是 LV5，但仍有上级邀请人`)
      }
      promotions.push({ config: item, user, needsUpdate: false })
      return
    }

    const inviterError = validateExpectedInviter(item, user)
    if (inviterError) errors.push(`待升级 LV5 ${label(item)}：${inviterError}`)
    promotions.push({ config: item, user, needsUpdate: true })
  })

  const inviteeGroups: InviteeGroupPlan[] = []
  CONFIG.inviteeGroups.forEach((group, groupIndex) => {
    const result = groupUsers[groupIndex]
    const inviter = result.inviter
    if (!inviter) {
      errors.push(`目标邀请人 ${label(group.inviter)} 查无账号`)
      return
    }
    if (!inviter.canInvite || inviter.invitedById != null) {
      errors.push(`目标邀请人 ${label(group.inviter)} 当前不是有效 LV5`)
    }

    const inviteesToUpdate: InviteeGroupPlan["inviteesToUpdate"] = []
    let alreadyDoneCount = 0

    group.invitees.forEach((item, inviteeIndex) => {
      const user = result.invitees[inviteeIndex]
      if (!user) {
        errors.push(`目标 LV4 ${label(item)} 查无账号`)
        return
      }
      if (user.id === inviter.id) {
        errors.push(`目标邀请人 ${label(group.inviter)} 不能成为自己的 LV4 下级`)
        return
      }

      const alreadyDone =
        !user.canInvite &&
        user.invitedById === inviter.id &&
        user.membershipLevel === MembershipLevel.FOUNDER &&
        user.discount.equals(inviter.discount) &&
        user.inviteCode == null &&
        user.inviteCodeExpiresAt == null
      if (alreadyDone) {
        alreadyDoneCount++
        return
      }

      if (user.canInvite) {
        errors.push(`目标 LV4 ${label(item)} 当前是 LV5，不能直接迁移`)
        return
      }
      if (user._count.invitees > 0) {
        errors.push(`目标 LV4 ${label(item)} 当前仍有 ${user._count.invitees} 个下级`)
        return
      }

      const inviterError = validateExpectedInviter(item, user, inviter.id)
      if (inviterError) {
        errors.push(`目标 LV4 ${label(item)}：${inviterError}`)
        return
      }
      inviteesToUpdate.push({ config: item, user })
    })

    inviteeGroups.push({ config: group, inviter, inviteesToUpdate, alreadyDoneCount })
  })

  if (errors.length) {
    throw new Error(`校验失败，未写入任何数据：\n${errors.map(e => `  - ${e}`).join("\n")}`)
  }

  return { promotions, inviteeGroups }
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
  console.log("【升级 LV5】")
  for (const item of plan.promotions) {
    console.log(
      item.needsUpdate
        ? `  - ${item.config.name}（${item.user.phone}，id=${item.user.id}）：[将] 解绑并升级为 LV5`
        : `  - ${item.config.name}（${item.user.phone}，id=${item.user.id}）：已是 LV5，跳过`
    )
  }

  console.log("\n【迁移 LV4】")
  for (const group of plan.inviteeGroups) {
    console.log(
      `  邀请人 ${group.config.inviter.name}（${group.inviter.phone}，id=${group.inviter.id}）：` +
        `[将] 更新 ${group.inviteesToUpdate.length} 人，已完成 ${group.alreadyDoneCount} 人`
    )
    for (const item of group.inviteesToUpdate) {
      console.log(`    - ${item.config.name}（${item.user.phone}，id=${item.user.id}）`)
    }
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  console.log(`=== 邀请关系批量迁移${dryRun ? "（DRY-RUN 预览，不写库）" : ""} ===\n`)

  const preview = await buildPlan(prisma)
  printPlan(preview)

  if (dryRun) {
    console.log("\n（DRY-RUN：未写入任何数据，去掉 --dry-run 正式执行）")
    return
  }

  await prisma.$transaction(
    async tx => {
      const plan = await buildPlan(tx)

      for (const item of plan.promotions.filter(item => item.needsUpdate)) {
        const cleared = await clearGrantedCredits(tx, item.user.id)
        const inviteCode = await generateUniqueCode(tx)
        await tx.user.update({
          where: { id: item.user.id },
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
        console.log(`已升级 ${item.config.name}：清零赠送批次 ${cleared} 笔，邀请码 ${inviteCode}`)
      }

      for (const group of plan.inviteeGroups) {
        for (const item of group.inviteesToUpdate) {
          await tx.user.update({
            where: { id: item.user.id },
            data: {
              canInvite: false,
              invitedById: group.inviter.id,
              membershipLevel: MembershipLevel.FOUNDER,
              inviteCode: null,
              inviteCodeExpiresAt: null,
              discount: group.inviter.discount,
            },
          })
        }
        console.log(
          `已迁移到 ${group.config.inviter.name} 名下：${group.inviteesToUpdate.length} 人`
        )
      }
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
