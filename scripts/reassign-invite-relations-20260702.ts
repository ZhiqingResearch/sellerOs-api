/**
 * 一次性修正：将本地数据文件指定用户从原邀请人下级解绑并升级为邀请人，
 * 同时把指定被邀请人迁移到新邀请人名下。
 *
 * 用法：
 *   npx ts-node scripts/reassign-invite-relations-20260702.ts --dry-run   # 预览，不写库
 *   npx ts-node scripts/reassign-invite-relations-20260702.ts             # 实际执行
 *
 * 保护：
 *   - 仅按手机号匹配用户，姓名只用于日志核对。
 *   - 执行前校验源邀请人、目标邀请人、被迁移用户的当前归属。
 *   - 正式执行在单事务内完成；任一校验失败则不写库。
 *   - 已迁移完成后重复运行会跳过，不重复清零赠送积分、不换邀请码。
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
interface InviteRelationReassignment {
  oldInviter: InviteUser
  newInviter: InviteUser
  movedInvitees: InviteUser[]
}

function loadReassignment(): InviteRelationReassignment {
  try {
    const requireData = createRequire(__filename)
    const data = requireData("./data/invite-relations.data") as {
      INVITE_RELATION_REASSIGNMENT_20260702?: InviteRelationReassignment
    }
    if (!data.INVITE_RELATION_REASSIGNMENT_20260702) {
      throw new Error("INVITE_RELATION_REASSIGNMENT_20260702 未定义")
    }
    return data.INVITE_RELATION_REASSIGNMENT_20260702
  } catch (e) {
    const cause = e instanceof Error ? `：${e.message}` : ""
    throw new Error(
      `缺少或无法读取本地名单文件 scripts/data/invite-relations.data.ts${cause}`
    )
  }
}

const {
  oldInviter: OLD_INVITER,
  newInviter: NEW_INVITER,
  movedInvitees: MOVED_INVITEES,
} = loadReassignment()

type Tx = Prisma.TransactionClient
type UserSnapshot = {
  id: number
  username: string
  phone: string
  canInvite: boolean
  invitedById: number | null
  discount: Decimal
}

function normalizePhone(phone: string) {
  return phone
    .trim()
    .replace(/^\+?86[-\s]?/, "")
    .replace(/\D/g, "")
}

function label(user: { name: string; phone: string }) {
  return `${user.name}（${normalizePhone(user.phone)}）`
}

async function findUserByPhone(phone: string): Promise<UserSnapshot | null> {
  return prisma.user.findUnique({
    where: { phone: normalizePhone(phone) },
    select: {
      id: true,
      username: true,
      phone: true,
      canInvite: true,
      invitedById: true,
      discount: true,
    },
  })
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

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  console.log(`=== 邀请关系迁移${dryRun ? "（DRY-RUN 预览，不写库）" : ""} ===\n`)

  const oldInviter = await findUserByPhone(OLD_INVITER.phone)
  const newInviter = await findUserByPhone(NEW_INVITER.phone)
  const movedUsers = await Promise.all(MOVED_INVITEES.map(u => findUserByPhone(u.phone)))
  const errors: string[] = []

  if (!oldInviter) errors.push(`源邀请人 ${label(OLD_INVITER)} 查无账号`)
  else if (!oldInviter.canInvite) errors.push(`源邀请人 ${label(OLD_INVITER)} 当前不是 LV5`)

  if (!newInviter) {
    errors.push(`新邀请人 ${label(NEW_INVITER)} 查无账号`)
  } else if (!newInviter.canInvite && oldInviter && newInviter.invitedById !== oldInviter.id) {
    errors.push(
      `新邀请人 ${label(NEW_INVITER)} 当前归属 id=${newInviter.invitedById ?? "无"}，不是源邀请人 id=${oldInviter.id}`
    )
  } else if (newInviter.canInvite && newInviter.invitedById != null) {
    errors.push(
      `新邀请人 ${label(NEW_INVITER)} 已是 LV5 但仍有 invitedById=${newInviter.invitedById}`
    )
  }

  MOVED_INVITEES.forEach((item, index) => {
    const user = movedUsers[index]
    if (!user) {
      errors.push(`被迁移用户 ${label(item)} 查无账号`)
      return
    }
    if (user.canInvite) {
      errors.push(`被迁移用户 ${label(item)} 当前是 LV5，不能迁移为下级`)
      return
    }
    if (!oldInviter || !newInviter) return
    const alreadyDone = user.invitedById === newInviter.id
    const fromOld = user.invitedById === oldInviter.id
    if (!alreadyDone && !fromOld) {
      errors.push(
        `被迁移用户 ${label(item)} 当前归属 id=${user.invitedById ?? "无"}，不是源邀请人 id=${oldInviter.id}`
      )
    }
  })

  if (errors.length) {
    console.log("校验失败，未写入任何数据：")
    errors.forEach(e => console.log("  - " + e))
    process.exitCode = 1
    return
  }

  if (!oldInviter || !newInviter) return

  const needPromoteNewInviter = !newInviter.canInvite
  const usersToMove = movedUsers.filter(
    (u): u is UserSnapshot => !!u && u.invitedById !== newInviter.id
  )

  console.log(`源邀请人：${OLD_INVITER.name}（${oldInviter.phone}，id=${oldInviter.id}）`)
  console.log(`新邀请人：${NEW_INVITER.name}（${newInviter.phone}，id=${newInviter.id}）`)
  console.log(
    needPromoteNewInviter
      ? "新邀请人：[将] 解绑并升级为 LV5，清零 PACKAGE+GIFT、撤订阅、发 24h 邀请码"
      : "新邀请人：已是 LV5，跳过升级"
  )
  console.log(
    `被邀请人：[将] 迁移 ${usersToMove.length} 人，已在目标名下 ${MOVED_INVITEES.length - usersToMove.length} 人\n`
  )

  for (const user of usersToMove) {
    console.log(`  - ${user.username}（${user.phone}，id=${user.id}）→ ${NEW_INVITER.name}`)
  }

  if (dryRun) {
    console.log("\n（DRY-RUN：未写入任何数据，去掉 --dry-run 正式执行）")
    return
  }

  await prisma.$transaction(
    async tx => {
      let inviteCode: string | null = null
      let cleared = 0

      if (needPromoteNewInviter) {
        cleared = await clearGrantedCredits(tx, newInviter.id)
        inviteCode = await generateUniqueCode(tx)
        await tx.user.update({
          where: { id: newInviter.id },
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

      for (const user of usersToMove) {
        await tx.user.update({
          where: { id: user.id },
          data: {
            invitedById: newInviter.id,
            membershipLevel: MembershipLevel.FOUNDER,
            discount: newInviter.discount,
          },
        })
      }

      console.log(
        needPromoteNewInviter
          ? `\n已升级新邀请人：清零赠送批次 ${cleared} 笔，邀请码 ${inviteCode}`
          : "\n新邀请人已是 LV5，未重复升级"
      )
    },
    { maxWait: 10_000, timeout: 60_000 }
  )

  console.log(`已迁移被邀请人 ${usersToMove.length} 人`)
  console.log("=== 完成 ===")
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => void prisma.$disconnect())
