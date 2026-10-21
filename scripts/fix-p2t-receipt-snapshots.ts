/**
 * 存量收据快照/订单修齐（2026-08-28 两个收据 bug 的存量数据修复）：
 * ① 个人转企业（PERSONAL_TO_TEAM）：订单 creditsTotal 漏算「超出抵扣返还充值积分」——
 *    重算 = 池套餐 + 池赠送 + 返还（取自订单 snapshot）；收据快照 totalCredits 重算 = 明细行 credits 求和。
 * ② 0 元单（免支付，order.channel 为空）：收据快照 channelLabel「在线支付」→「——」（与支付记录同口径）。
 * 代码修复只对新数据生效，存量冻结快照/订单需跑本脚本。幂等，可随时重跑。用法：
 *   TS_NODE_TRANSPILE_ONLY=true npx ts-node scripts/fix-p2t-receipt-snapshots.ts --dry-run   # 先看影响面
 *   TS_NODE_TRANSPILE_ONLY=true npx ts-node scripts/fix-p2t-receipt-snapshots.ts             # 正式修齐
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")

interface ReceiptItem {
  credits?: number | null
}
interface ReceiptSnapshot {
  channelLabel?: string
  totalCredits?: number
  items?: ReceiptItem[]
  [k: string]: unknown
}
interface P2tSnapshot {
  poolPackageCredits?: number
  poolGiftCredits?: number
  refundCredits?: number
}

async function main() {
  let orderFixed = 0
  let receiptCreditsFixed = 0
  let channelFixed = 0

  // ---- ① P2T 订单 creditsTotal + 收据 totalCredits ----
  const p2tOrders = await prisma.billingOrder.findMany({
    where: { type: "PERSONAL_TO_TEAM" },
    select: {
      id: true,
      orderNo: true,
      creditsTotal: true,
      snapshot: true,
      receipt: { select: { id: true, receiptNo: true, snapshot: true } },
    },
    orderBy: { id: "asc" },
  })
  for (const o of p2tOrders) {
    const snap = o.snapshot as unknown as P2tSnapshot | null
    if (!snap) continue
    const expected =
      (snap.poolPackageCredits ?? 0) + (snap.poolGiftCredits ?? 0) + (snap.refundCredits ?? 0)
    if (Number(o.creditsTotal ?? 0) !== expected) {
      orderFixed++
      console.log(`  订单 ${o.orderNo}：creditsTotal ${o.creditsTotal ?? 0} → ${expected}`)
      if (!dryRun) {
        await prisma.billingOrder.update({ where: { id: o.id }, data: { creditsTotal: expected } })
      }
    }
    const r = o.receipt
    if (r) {
      const rs = r.snapshot as unknown as ReceiptSnapshot
      const sum = (rs.items ?? []).reduce((s, i) => s + (i.credits ?? 0), 0)
      if (rs.totalCredits !== sum) {
        receiptCreditsFixed++
        console.log(`  收据 ${r.receiptNo}：totalCredits ${rs.totalCredits} → ${sum}`)
        if (!dryRun) {
          await prisma.receipt.update({
            where: { id: r.id },
            data: { snapshot: { ...rs, totalCredits: sum } },
          })
        }
      }
    }
  }

  // ---- ② 免支付收据 channelLabel「在线支付」→「——」 ----
  const noChannelReceipts = await prisma.receipt.findMany({
    where: { order: { is: { channel: null } } },
    select: { id: true, receiptNo: true, snapshot: true },
    orderBy: { id: "asc" },
  })
  for (const r of noChannelReceipts) {
    const rs = r.snapshot as unknown as ReceiptSnapshot
    if (rs.channelLabel && rs.channelLabel !== "——") {
      channelFixed++
      console.log(`  收据 ${r.receiptNo}：channelLabel「${rs.channelLabel}」→「——」`)
      if (!dryRun) {
        await prisma.receipt.update({
          where: { id: r.id },
          data: { snapshot: { ...rs, channelLabel: "——" } },
        })
      }
    }
  }

  console.log(
    `${dryRun ? "dry-run（不写入）" : "修齐完成"}：订单 creditsTotal ${orderFixed} 笔，` +
      `收据 totalCredits ${receiptCreditsFixed} 张，channelLabel ${channelFixed} 张`
  )
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
