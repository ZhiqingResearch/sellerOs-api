/**
 * 一次性回填：邀请关系（生产真实名单）→ 设邀请人 LV5、被邀请人 LV4。
 *
 * 数据来源：本地 scripts/data/invite-relations.data.ts（不提交）。仅按手机号匹配用户，
 * 姓名只供日志核对、不参与匹配。
 *
 * 用法：
 *   npx ts-node scripts/backfill-invite-relations.ts --dry-run   # 预览，不写库（务必先跑）
 *   npx ts-node scripts/backfill-invite-relations.ts             # 实际执行
 *
 * 行为（与 InviteService 同口径，避免漂移）：
 *   邀请人（开邀请 → LV5，对应 setInviteConfig 的「开启」分支）：
 *     - 清零 PACKAGE + GIFT 赠送积分（逐批写 EXPIRE 流水，source=invite.switch），RECHARGE 充值积分不动；
 *     - 撤销订阅（subscriptionTier/Start/ExpiresAt 置空）；
 *     - membershipLevel=INVITER，生成唯一邀请码 + 7 天有效期。
 *   被邀请人（→ LV4，对应 approve 的字段）：
 *     - invitedById = 对应邀请人；membershipLevel=FOUNDER；继承邀请人当时的 discount。
 *     - **不补发 200 体验积分**（仅新注册送，存量用户不补——见部署文档决策3）。
 *
 * 幂等（可安全重复执行）：
 *   - 邀请人已 canInvite=true → 跳过（不重复清零 / 换码）。
 *   - 被邀请人 invitedById 已指向同一邀请人 → 跳过；指向他人 → 冲突告警、不覆盖。
 *   - 手机号查无用户 / 数据异常 → 计入告警清单，不中断整批。
 *
 * ⚠️ 前置：先 `prisma db push` 应用新表/字段，并跑完 `migrate-balance-to-credits.ts`；
 *    建议先备份库 → `--dry-run` 核对 → 再正式执行。
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

/** 邀请码有效期（与 membership.constants.INVITE_CODE_TTL_HOURS 一致） */
const CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 邀请码字符集（与 InviteService 一致：去掉易混字符，前缀 OS + 4 位） */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

interface InviteUser {
  name: string
  phone: string
}
interface InviterGroup extends InviteUser {
  invitees: InviteUser[]
}

function loadGroups(): InviterGroup[] {
  try {
    const requireData = createRequire(__filename)
    const data = requireData("./data/invite-relations.data") as {
      BACKFILL_INVITE_GROUPS?: InviterGroup[]
    }
    if (!Array.isArray(data.BACKFILL_INVITE_GROUPS)) {
      throw new Error("BACKFILL_INVITE_GROUPS 不是数组")
    }
    return data.BACKFILL_INVITE_GROUPS
  } catch (e) {
    const cause = e instanceof Error ? `：${e.message}` : ""
    throw new Error(
      `缺少或无法读取本地名单文件 scripts/data/invite-relations.data.ts${cause}`
    )
  }
}

const GROUPS = loadGroups()

const warnings: string[] = []
function warn(msg: string) {
  warnings.push(msg)
  console.warn("  ⚠️ " + msg)
}

/** 可消费积分余额（RECHARGE+PACKAGE+GIFT，ACTIVE 且未过期）——复刻 displayBalance 非 REBATE 口径。 */
async function consumableBalance(tx: Prisma.TransactionClient, userId: number): Promise<Decimal> {
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

/** 清零某用户 PACKAGE+GIFT 赠送积分（逐批写 EXPIRE，source=invite.switch）——复刻 credit.service.clearGrantedCredits。 */
async function clearGrantedCredits(tx: Prisma.TransactionClient, userId: number): Promise<number> {
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

/** 生成唯一邀请码（前缀 OS + 4 位）——复刻 InviteService.generateUniqueCode。 */
async function generateUniqueCode(tx: Prisma.TransactionClient): Promise<string> {
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
  console.log(`=== 邀请关系回填${dryRun ? "（DRY-RUN 预览，不写库）" : ""} ===\n`)

  let inviterSet = 0
  let inviterSkip = 0
  let inviteeSet = 0
  let inviteeSkip = 0

  for (const group of GROUPS) {
    console.log(`【邀请人】${group.name}（${group.phone}）下级 ${group.invitees.length} 人`)

    // ---- 1) 邀请人 → LV5 ----
    const inviter = await prisma.user.findUnique({
      where: { phone: group.phone },
      select: { id: true, username: true, canInvite: true, invitedById: true, discount: true },
    })
    if (!inviter) {
      warn(`邀请人 ${group.name}（${group.phone}）查无账号，跳过其全部下级`)
      continue
    }
    if (inviter.invitedById != null) {
      warn(
        `邀请人 ${group.name}（${group.phone}）已是某人的被邀请人(LV4)，不能再设为 LV5，跳过其全部下级`
      )
      continue
    }

    const inviterDiscount = inviter.discount
    if (inviter.canInvite) {
      console.log(`  · 邀请人已是 LV5，跳过开通`)
      inviterSkip++
    } else if (dryRun) {
      console.log(`  · [将] 开 LV5：清零 PACKAGE+GIFT、撤订阅、置 INVITER、发 7 天邀请码`)
      inviterSet++
    } else {
      await prisma.$transaction(async tx => {
        const cleared = await clearGrantedCredits(tx, inviter.id)
        const inviteCode = await generateUniqueCode(tx)
        await tx.user.update({
          where: { id: inviter.id },
          data: {
            canInvite: true,
            subscriptionTier: null,
            subscriptionStart: null,
            subscriptionExpiresAt: null,
            membershipLevel: MembershipLevel.INVITER,
            inviteCode,
            inviteCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
          },
        })
        console.log(`  · 已开 LV5（清零赠送批次 ${cleared} 笔，邀请码 ${inviteCode}）`)
      })
      inviterSet++
    }

    // ---- 2) 被邀请人 → LV4 ----
    for (const invitee of group.invitees) {
      const u = await prisma.user.findUnique({
        where: { phone: invitee.phone },
        select: { id: true, username: true, canInvite: true, invitedById: true },
      })
      if (!u) {
        warn(`被邀请人 ${invitee.name}（${invitee.phone}）查无账号，跳过`)
        continue
      }
      if (u.canInvite) {
        warn(`被邀请人 ${invitee.name}（${invitee.phone}）本身是邀请人(LV5)，不能设为 LV4，跳过`)
        continue
      }
      if (u.invitedById != null) {
        if (u.invitedById === inviter.id) {
          inviteeSkip++ // 已是该邀请人下级，幂等跳过
        } else {
          warn(
            `被邀请人 ${invitee.name}（${invitee.phone}）已归属邀请人 id=${u.invitedById}，与名单(${group.name})冲突，不覆盖`
          )
        }
        continue
      }
      if (dryRun) {
        inviteeSet++
        continue
      }
      await prisma.user.update({
        where: { id: u.id },
        data: {
          invitedById: inviter.id,
          membershipLevel: MembershipLevel.FOUNDER,
          discount: inviterDiscount, // 继承邀请人当时折扣
        },
      })
      inviteeSet++
    }
    console.log("")
  }

  console.log("=== 汇总 ===")
  console.log(
    `邀请人：开通 ${inviterSet} 人｜已是LV5跳过 ${inviterSkip} 人\n` +
      `被邀请人：设为LV4 ${inviteeSet} 人｜已归属跳过 ${inviteeSkip} 人\n` +
      `告警：${warnings.length} 条`
  )
  if (warnings.length) {
    console.log("\n⚠️ 告警明细（请人工核对，多为手机号未注册）：")
    warnings.forEach(w => console.log("  - " + w))
  }
  if (dryRun) console.log("\n（DRY-RUN：未写入任何数据，去掉 --dry-run 正式执行）")
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => void prisma.$disconnect())
