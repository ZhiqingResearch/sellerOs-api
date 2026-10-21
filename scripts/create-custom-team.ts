/**
 * 平台定制开通企业（不走订单/支付，用于联调测试或线下合同客户）。
 *
 * 默认给内部账号（18888888888）开通「内部测试企业」：10 席、一年有效、
 * 池 50000 套餐积分（30 天过期）+ 20000 充值积分（永不过期）、折扣 1。
 * 幂等：该账号已是 ACTIVE 团队成员时跳过创建。
 *
 * 用法（必须用 ts-node + tsconfig-paths；tsx 不支持装饰器元数据，Nest DI 会失败）：
 *   TS_NODE_TRANSPILE_ONLY=true npx ts-node -r tsconfig-paths/register scripts/create-custom-team.ts
 *
 * 环境变量覆盖默认值：
 *   TEAM_ADMIN_PHONE=18888888888 TEAM_NAME=内部测试企业 TEAM_SEATS=10 TEAM_DAYS=365 \
 *   TEAM_PACKAGE_CREDITS=50000 TEAM_RECHARGE_CREDITS=20000 TEAM_DISCOUNT=1 \
 *   TS_NODE_TRANSPILE_ONLY=true npx ts-node -r tsconfig-paths/register scripts/create-custom-team.ts
 */

import "dotenv/config"
import { NestFactory } from "@nestjs/core"
import { AppModule } from "../src/app.module"
import { TeamService } from "../src/team/team.service"
import { PrismaService } from "../src/prisma/prisma.service"
import { DAY_MS } from "../src/membership/membership.constants"

const ADMIN_PHONE = process.env.TEAM_ADMIN_PHONE ?? "18888888888"
const TEAM_NAME = process.env.TEAM_NAME ?? "内部测试企业"
const SEATS = Number(process.env.TEAM_SEATS ?? 10)
const DAYS = Number(process.env.TEAM_DAYS ?? 365)
const PACKAGE_CREDITS = Number(process.env.TEAM_PACKAGE_CREDITS ?? 50000)
const RECHARGE_CREDITS = Number(process.env.TEAM_RECHARGE_CREDITS ?? 20000)
const DISCOUNT = Number(process.env.TEAM_DISCOUNT ?? 1)

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
  try {
    const prisma = app.get(PrismaService)
    const teamService = app.get(TeamService)

    const admin = await prisma.user.findUnique({
      where: { phone: ADMIN_PHONE },
      select: { id: true, username: true },
    })
    if (!admin) throw new Error(`未找到管理员账号（手机 ${ADMIN_PHONE}）`)

    const occupied = await prisma.teamMember.findFirst({
      where: { userId: admin.id, status: "ACTIVE", team: { status: { in: ["ACTIVE", "GRACE"] } } },
      select: { teamId: true },
    })
    if (occupied) {
      console.log(`该账号已归属企业 teamId=${occupied.teamId}，跳过创建`)
      return
    }

    const expiresAt = new Date(Date.now() + DAYS * DAY_MS)
    const detail = (await teamService.createCustomTeam(0, {
      name: TEAM_NAME,
      seats: SEATS,
      expiresAt: expiresAt.toISOString(),
      poolPackageCredits: PACKAGE_CREDITS,
      poolRechargeCredits: RECHARGE_CREDITS,
      discount: DISCOUNT,
      contractNote: "脚本开通（scripts/create-custom-team.ts）",
      adminUserId: admin.id,
    })) as { id: number }

    console.log(
      `企业已开通：teamId=${detail.id}「${TEAM_NAME}」管理员=${admin.username}(${admin.id}) ` +
        `席位=${SEATS} 到期=${expiresAt.toISOString().slice(0, 10)} 池=${PACKAGE_CREDITS}套餐+${RECHARGE_CREDITS}充值`
    )
  } finally {
    await app.close()
  }
}

main().catch(e => {
  console.error("失败:", e instanceof Error ? e.message : e)
  process.exit(1)
})
