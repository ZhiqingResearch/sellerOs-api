import { Prisma, PrismaClient } from "@prisma/client"
import { mkdir, open, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// 固定导出范围；Role 是 RoleModel 的实际数据库表名。
export const TABLES = [
  "PermissionGroup", "Permission", "Role", "RolePermission", "User", "UserRole",
  "EmailAccount", "Organization", "UserOrganization", "AiGatewayModel",
  "AiGatewayVideoFixedPrice", "AiModel", "FeatureModule", "PricingConfig",
  "MembershipPlan", "RechargePack", "TeamPlan", "TeamPack", "CustomLadderTier",
  "RebateRule", "ImagePromptTemplate", "ImageTemplateGroup", "ImageTemplate",
  "ImageTemplateItem", "ProductPublishClassificationCatalog", "ProductPublishStore",
  "ProductPublishStoreClassification", "PublicAvatar", "PublicVoice", "SensitiveWord",
  "SkillMarketSkill", "OpenApiApp", "Tag",
]
const PAGE_SIZE = 200
const BINARY_TYPES = new Set(["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob", "bit"])
const quote = name => `\`${name.replaceAll("`", "``")}\``

export function sqlValue(hex, type) {
  if (hex === null) return "NULL"
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})*$/i.test(hex))
    throw new Error("数据库返回了无效的十六进制数据，导出已停止")
  // 让 MySQL 处理日期、JSON、Decimal 和 BigInt，避免经过 JS 数值/日期转换。
  const value = `X'${hex}'`
  return BINARY_TYPES.has(type) ? value : `CONVERT(${value} USING utf8mb4)`
}

export function parseArgs(args) {
  const options = { dryRun: false, help: false, output: resolve(`seedbackups/bootstrap-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`) }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--dry-run") options.dryRun = true
    else if (args[index] === "--help") options.help = true
    else if (args[index] === "--output" && args[index + 1] && !args[index + 1].startsWith("--"))
      options.output = resolve(args[++index])
    else throw new Error("用法：npm run export:bootstrap-sql -- [--dry-run] [--output <文件.sql>]")
  }
  return options
}

export async function exportBootstrapData(prisma, { output, dryRun = false }, log = console.log) {
  let file
  try {
    if (!dryRun) {
      await mkdir(dirname(output), { recursive: true })
      // 含全部账号、密码哈希和接入密钥；仅文件所有者可读写，不覆盖已有文件。
      file = await open(output, "wx", 0o600)
    }
    const write = text => file ? file.writeFile(text, "utf8") : Promise.resolve()
    const summary = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET SESSION time_zone = '+00:00'")
      const columns = await tx.$queryRawUnsafe(`
        SELECT c.TABLE_NAME AS tableName, c.COLUMN_NAME AS columnName,
               c.DATA_TYPE AS dataType, c.COLUMN_KEY AS columnKey, c.EXTRA AS extra,
               t.ENGINE AS engine
        FROM information_schema.COLUMNS c
        JOIN information_schema.TABLES t
          ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = DATABASE()
          AND LOWER(c.TABLE_NAME) IN (${TABLES.map(() => "?").join(",")})
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`, ...TABLES.map(table => table.toLowerCase()))
      const metadata = new Map(TABLES.map(table => [table, columns.filter(column => column.tableName.toLowerCase() === table.toLowerCase())]))
      for (const [table, fields] of metadata) {
        if (!fields.length) throw new Error(`缺少表 ${table}，请先检查源库和表结构`)
        if (fields.some(field => field.engine !== "InnoDB"))
          throw new Error(`${table} 不是 InnoDB，无法保证一致性快照`)
        if (!fields.some(field => field.columnKey === "PRI")) throw new Error(`${table} 缺少主键，无法稳定分页`)
      }
      await write(`-- SellerOS 33张表全量数据；生成时间 ${new Date().toISOString()}
-- 仅导入使用同版本 Prisma Schema 建好的空库；不要提前运行 seed。
-- 保留原ID、账号及业务配置。包含密码哈希、OpenApiApp密钥，请妥善保管。
-- 本文件不复制素材文件，不创建表，也不删除或覆盖目标库已有数据。
SET NAMES utf8mb4;
SET @bootstrap_old_time_zone = @@SESSION.time_zone;
SET @bootstrap_old_sql_mode = @@SESSION.sql_mode;
SET @bootstrap_old_foreign_key_checks = @@SESSION.foreign_key_checks;
SET SESSION time_zone = '+00:00';
SET SESSION sql_mode = CONCAT_WS(',', @@SESSION.sql_mode, 'NO_AUTO_VALUE_ON_ZERO');
SET SESSION foreign_key_checks = 0;
START TRANSACTION;
\n`)
      const counts = []
      for (const [table, allFields] of metadata) {
        const fields = allFields.filter(field => !/\b(?:VIRTUAL|STORED) GENERATED\b/i.test(field.extra))
        const [row] = await tx.$queryRawUnsafe(`SELECT COUNT(*) AS count FROM ${quote(table)}`)
        const count = BigInt(row.count)
        counts.push({ table, count: count.toString() })
        log(`${table}: ${count} 行`)
        if (dryRun) continue
        await write(`-- ${table}: ${count} 行\n`)
        const projection = fields.map(field => {
          const column = quote(field.columnName)
          return `HEX(${BINARY_TYPES.has(field.dataType) ? column : `CONVERT(${column} USING utf8mb4)`}) AS ${column}`
        }).join(", ")
        const order = allFields.filter(field => field.columnKey === "PRI").map(field => quote(field.columnName)).join(", ")
        const insert = `INSERT INTO ${quote(table)} (${fields.map(field => quote(field.columnName)).join(", ")}) VALUES `
        let exported = 0n
        for (let offset = 0; ; offset += PAGE_SIZE) {
          const rows = await tx.$queryRawUnsafe(`SELECT ${projection} FROM ${quote(table)} ORDER BY ${order} LIMIT ? OFFSET ?`, PAGE_SIZE, offset)
          for (const record of rows) {
            await write(`${insert}(${fields.map(field => sqlValue(record[field.columnName], field.dataType)).join(", ")});\n`)
          }
          exported += BigInt(rows.length)
          if (rows.length < PAGE_SIZE) break
        }
        if (exported !== count) throw new Error(`${table} 导出行数不一致，已停止`)
        await write("\n")
      }
      await write(`COMMIT;
SET SESSION foreign_key_checks = @bootstrap_old_foreign_key_checks;
SET SESSION time_zone = @bootstrap_old_time_zone;
SET SESSION sql_mode = @bootstrap_old_sql_mode;
`)
      return counts
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 600_000 })
    if (file) await file.close()
    return summary
  } catch (error) {
    if (file) {
      await file.close().catch(() => undefined)
      await rm(output).catch(() => undefined)
    }
    throw error
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log("用法：npm run export:bootstrap-sql -- [--dry-run] [--output <文件.sql>]\n连接当前环境 DATABASE_URL；仅导出33张表全部数据，不修改源库。")
    return
  }
  if (!process.env.DATABASE_URL) throw new Error("请在环境变量或 .env 中配置源库 DATABASE_URL")
  const prisma = new PrismaClient({ log: [] })
  try {
    const summary = await exportBootstrapData(prisma, options)
    const total = summary.reduce((sum, item) => sum + BigInt(item.count), 0n)
    console.log(options.dryRun ? `预检完成：${summary.length} 张表，共 ${total} 行，未生成SQL。` : `导出完成：${summary.length} 张表，共 ${total} 行 → ${options.output}`)
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const message = error.name?.startsWith("Prisma")
      ? `数据库读取失败（${error.code || "连接或查询异常"}），请检查源库连接、权限及表结构`
      : error.message
    console.error(`SQL导出失败：${message}`)
    process.exitCode = 1
  })
}
