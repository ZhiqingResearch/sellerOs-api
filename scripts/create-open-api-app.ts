/** 对外开放接口接入方管理；导入本文件不会连接数据库，运行 --help 查看用法。 */
import { Prisma, PrismaClient } from "@prisma/client"
import { randomBytes } from "crypto"

export const OPEN_API_APP_HELP = `用法：
  create-open-api-app.ts <接入方名> [单笔上限元] [--keyb-project selleros]
  create-open-api-app.ts --list
  create-open-api-app.ts --disable <appId>
  create-open-api-app.ts --grant-keyb <appId> selleros
  create-open-api-app.ts --revoke-keyb <appId> selleros
  create-open-api-app.ts --grant-niuniu-plan <appId>
  create-open-api-app.ts --revoke-niuniu-plan <appId>
  create-open-api-app.ts --help

创建时不加 --keyb-project 则不授予 KeyB 扣费权限。
已创建的服务通过 --grant-keyb 授权，无需重新创建或修改环境变量。
授权和撤权幂等执行，仅修改项目权限；授权不会启用已停用的服务。
appSecret 仅在创建成功时输出，请立即安全保存。`

export type OpenApiAppCommand =
  | { action: "help" }
  | { action: "list" }
  | { action: "disable"; appId: string }
  | { action: "grant-niuniu-plan"; appId: string }
  | { action: "revoke-niuniu-plan"; appId: string }
  | { action: "grant-keyb"; appId: string; projectCode: string }
  | { action: "revoke-keyb"; appId: string; projectCode: string }
  | { action: "create"; name: string; perCallMaxCny: number | null; keybProjectCodes: string[] }

class OpenApiAppCliError extends Error {}

function validateAppId(appId: string): string {
  if (!appId || appId.length > 32 || /[^A-Za-z0-9_-]/.test(appId)) {
    throw new OpenApiAppCliError("appId 必须为 1～32 位字母、数字、下划线或连字符")
  }
  return appId
}

function validateProjectCode(projectCode: string): string {
  if (projectCode !== "selleros") {
    throw new OpenApiAppCliError("未登记的 KeyB 项目，当前仅支持 selleros")
  }
  return projectCode
}

export function parseOpenApiAppArgs(args: string[]): OpenApiAppCommand {
  if (["--grant-niuniu-plan", "--revoke-niuniu-plan"].includes(args[0]) && args.length === 2) {
    return {
      action: args[0] === "--grant-niuniu-plan" ? "grant-niuniu-plan" : "revoke-niuniu-plan",
      appId: validateAppId(args[1]),
    }
  }
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { action: "help" }
  if (args.length === 1 && args[0] === "--list") return { action: "list" }
  if (args[0] === "--disable" && args.length === 2) {
    return { action: "disable", appId: validateAppId(args[1]) }
  }
  if (["--grant-keyb", "--revoke-keyb"].includes(args[0]) && args.length === 3) {
    return {
      action: args[0] === "--grant-keyb" ? "grant-keyb" : "revoke-keyb",
      appId: validateAppId(args[1]),
      projectCode: validateProjectCode(args[2]),
    }
  }
  if (!args[0] || args[0].startsWith("-")) {
    throw new OpenApiAppCliError("命令或参数不正确，请运行 --help 查看用法")
  }

  const name = args[0].trim()
  const hasControlCharacter = Array.from(name).some(char => {
    const code = char.charCodeAt(0)
    return code < 32 || code === 127
  })
  if (!name || name.length > 50 || hasControlCharacter) {
    throw new OpenApiAppCliError("接入方名须为 1～50 个字符，且不可包含控制字符")
  }
  let remaining = args.slice(1)
  let perCallMaxCny: number | null = null
  if (remaining.length && !remaining[0].startsWith("--")) {
    perCallMaxCny = Number(remaining[0])
    if (!Number.isFinite(perCallMaxCny) || perCallMaxCny <= 0) {
      throw new OpenApiAppCliError("单笔上限必须为正数（元）")
    }
    remaining = remaining.slice(1)
  }
  let keybProjectCodes: string[] = []
  if (remaining.length) {
    if (remaining.length !== 2 || remaining[0] !== "--keyb-project") {
      throw new OpenApiAppCliError("未知选项或多余参数，请运行 --help 查看用法")
    }
    keybProjectCodes = [validateProjectCode(remaining[1])]
  }
  return { action: "create", name, perCallMaxCny, keybProjectCodes }
}

type Output = Pick<Console, "log" | "table" | "error">
type Database = Pick<PrismaClient, "openApiApp" | "$transaction">

function readProjectCodes(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    throw new OpenApiAppCliError("接入方项目权限数据格式异常，请核对数据库后重试")
  }
  return value
}

export async function runOpenApiAppCommand(
  command: OpenApiAppCommand,
  prisma: Database,
  output: Output = console
): Promise<void> {
  if (command.action === "help") {
    output.log(OPEN_API_APP_HELP)
    return
  }
  if (command.action === "list") {
    const rows = await prisma.openApiApp.findMany({
      select: {
        appId: true,
        name: true,
        status: true,
        perCallMaxCny: true,
        keybProjectCodes: true,
        isNiuniuOperationPlanEnabled: true,
        createdAt: true,
      },
      orderBy: { id: "asc" },
    })
    output.table(
      rows.map(row => ({
        ...row,
        perCallMaxCny: row.perCallMaxCny?.toString() ?? null,
        keybProjectCodes: readProjectCodes(row.keybProjectCodes).join(",") || "无",
      }))
    )
    return
  }
  if (command.action === "disable") {
    const result = await prisma.openApiApp.updateMany({
      where: { appId: command.appId },
      data: { status: "DISABLED" },
    })
    if (!result.count) throw new OpenApiAppCliError(`接入方不存在：${command.appId}`)
    output.log(`已停用：${command.appId}`)
    return
  }
  if (command.action === "grant-niuniu-plan" || command.action === "revoke-niuniu-plan") {
    const result = await prisma.openApiApp.updateMany({
      where: { appId: command.appId },
      data: { isNiuniuOperationPlanEnabled: command.action === "grant-niuniu-plan" },
    })
    if (!result.count) throw new OpenApiAppCliError(`接入方不存在：${command.appId}`)
    output.log(
      `${command.action === "grant-niuniu-plan" ? "已开通" : "已关闭"}牛牛运营计划：${command.appId}`
    )
    return
  }
  if (command.action === "grant-keyb" || command.action === "revoke-keyb") {
    await prisma.$transaction(async tx => {
      // 锁定后读取最新权限；同一接入方的授权/撤权串行执行，避免 JSON 读改写丢授权。
      const rows = await tx.$queryRaw<Array<{ id: number; keybProjectCodes: Prisma.JsonValue }>>`
        SELECT id, keybProjectCodes FROM OpenApiApp WHERE appId = ${command.appId} FOR UPDATE
      `
      const row = rows[0]
      if (!row) throw new OpenApiAppCliError(`接入方不存在：${command.appId}`)
      const existing = readProjectCodes(row.keybProjectCodes)
      const present = existing.includes(command.projectCode)
      if (present === (command.action === "grant-keyb")) return
      const keybProjectCodes =
        command.action === "grant-keyb"
          ? [...existing, command.projectCode]
          : existing.filter(code => code !== command.projectCode)
      await tx.openApiApp.update({ where: { id: row.id }, data: { keybProjectCodes } })
    })
    output.log(
      `${command.action === "grant-keyb" ? "已授权" : "已撤销授权"}：${command.appId} → ${command.projectCode}`
    )
    return
  }

  const appId = randomBytes(8).toString("hex")
  const appSecret = randomBytes(32).toString("hex")
  const { name, perCallMaxCny, keybProjectCodes } = command
  await prisma.openApiApp.create({
    data: { appId, appSecret, name, perCallMaxCny, keybProjectCodes },
  })
  output.log(`接入方已创建：
  name:             ${name}
  appId:            ${appId}
  appSecret:        ${appSecret}
  perCallMaxCny:    ${perCallMaxCny ?? "不限"}
  keybProjectCodes: ${keybProjectCodes.join(",") || "无"}
⚠️ appSecret 仅在创建成功时输出，请立即保存到接入方后端 Secret 配置，不可交给浏览器或 MCP。`)
}

export async function mainOpenApiApp(
  args: string[] = process.argv.slice(2),
  createClient: () => PrismaClient = () => new PrismaClient(),
  output: Output = console
): Promise<number> {
  let prisma: PrismaClient | undefined
  let exitCode = 0
  try {
    const command = parseOpenApiAppArgs(args)
    if (command.action === "help") {
      output.log(OPEN_API_APP_HELP)
    } else {
      prisma = createClient()
      await runOpenApiAppCommand(command, prisma, output)
    }
  } catch (error) {
    // Prisma 错误可能包含 create 参数及 appSecret；禁止输出原始异常/堆栈。
    output.error(
      error instanceof OpenApiAppCliError
        ? error.message
        : "接入方操作失败，请检查数据库连接、结构同步及运行权限后重试（敏感错误详情已隐藏）"
    )
    exitCode = 1
  } finally {
    if (prisma) {
      try {
        await prisma.$disconnect()
      } catch {
        output.error("数据库连接关闭失败（敏感错误详情已隐藏）")
        exitCode = 1
      }
    }
  }
  return exitCode
}

if (require.main === module) {
  void mainOpenApiApp().then(exitCode => {
    process.exitCode = exitCode
  })
}
