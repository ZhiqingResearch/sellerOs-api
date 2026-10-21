/**
 * 创建内部账号（菜单/路由配置专用，见 src/auth/guards/internal-account.guard.ts）。
 *
 * 默认：手机号 18888888888，密码 OS0911，用户名「内部账号」，并绑定内置超级管理员角色（code=ADMIN）。
 *
 * 行为（幂等，可重复跑）：
 *   - 用户不存在 → 创建（密码 argon2 哈希落库，不强制首登改密）
 *   - 用户已存在 → 默认不动密码；带 --reset-password 才重置为指定密码
 *   - 已停用（isActive=false）→ 自动重新启用并打印提示
 *   - 超管角色未绑定 → 补绑定；角色不存在（未跑 seed）→ 报错退出，提示先跑 seed
 *
 * 用法：
 *   npx ts-node scripts/create-internal-account.ts
 *   npx ts-node scripts/create-internal-account.ts --reset-password
 *   PHONE=19999999999 PASSWORD=xxx npx ts-node scripts/create-internal-account.ts   # 覆盖默认值
 *
 * 注意：该账号能否访问 /api/menus* 由环境变量 INTERNAL_ACCOUNT_PHONE 决定（默认即 18888888888）；
 *       若用 PHONE 覆盖了手机号，记得同步改服务端的 INTERNAL_ACCOUNT_PHONE。
 */

import { PrismaClient } from "@prisma/client"
import * as argon2 from "argon2"

const PHONE = process.env.PHONE ?? "18888888888"
const PASSWORD = process.env.PASSWORD ?? "OS0911"
const USERNAME = process.env.USERNAME_CN ?? "内部账号"
const ADMIN_ROLE_CODE = "ADMIN"

async function main() {
  const resetPassword = process.argv.slice(2).includes("--reset-password")
  const prisma = new PrismaClient()

  try {
    // 超管角色必须先存在（由 seed 写入），否则该账号进不了「用户与权限」页面
    const adminRole = await prisma.roleModel.findUnique({
      where: { code: ADMIN_ROLE_CODE },
      select: { id: true, name: true },
    })
    if (!adminRole) {
      console.error(
        `未找到内置超级管理员角色（code=${ADMIN_ROLE_CODE}）。请先执行：npx ts-node prisma/seed.ts`
      )
      process.exitCode = 1
      return
    }

    let user = await prisma.user.findUnique({
      where: { phone: PHONE },
      select: { id: true, username: true, isActive: true, mustChangePassword: true },
    })

    if (!user) {
      const password = await argon2.hash(PASSWORD)
      const created = await prisma.user.create({
        data: {
          username: USERNAME,
          phone: PHONE,
          password,
          mustChangePassword: false, // 内部固定密码账号，不走首登强制改密
        },
        select: { id: true, username: true, isActive: true, mustChangePassword: true },
      })
      user = created
      console.log(`✔ 已创建用户 ${USERNAME}（${PHONE}，#${created.id}），密码已设置`)
    } else {
      console.log(`用户已存在：${user.username}（${PHONE}，#${user.id}）`)
      if (resetPassword) {
        const password = await argon2.hash(PASSWORD)
        await prisma.user.update({
          where: { id: user.id },
          data: { password, mustChangePassword: false },
        })
        console.log("✔ 密码已重置")
      } else {
        console.log("  密码未改动（如需重置加 --reset-password）")
      }
      if (!user.isActive) {
        await prisma.user.update({ where: { id: user.id }, data: { isActive: true } })
        console.log("✔ 该账号此前已停用，已重新启用")
      }
    }

    // 绑定超管角色（复合主键 upsert，幂等）
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
      update: {},
      create: { userId: user.id, roleId: adminRole.id },
    })
    console.log(`✔ 已确保绑定角色「${adminRole.name}」`)

    console.log(
      `\n完成。提醒：/api/menus* 的访问由环境变量 INTERNAL_ACCOUNT_PHONE 控制（默认 18888888888），需与该手机号一致。`
    )
  } finally {
    await prisma.$disconnect()
  }
}

void main()
