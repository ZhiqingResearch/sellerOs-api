import { Prisma, PrismaClient } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { AiGatewayClient } from "@zhiqingresearch/ai-ts-sdk"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  CHETAIDOU_IMAGE_RATIOS,
  CHETAIDOU_IMAGE_TIERS,
  planChetaidouImage,
} from "../src/chetaidou/chetaidou-image-options.service"
import { stableHash } from "../src/chetaidou/chetaidou-storage.service"
import { CHETAIDOU_IMAGE_CATEGORY } from "../src/chetaidou/chetaidou.constants"

const category = CHETAIDOU_IMAGE_CATEGORY
type Model = Prisma.AiGatewayModelGetPayload<Record<string, never>>
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as any
const fingerprint = (rows: Model[]) =>
  stableHash(json(rows.slice().sort((a, b) => a.publicId.localeCompare(b.publicId))))

export function assertSwitchSource(
  rows: Model[],
  from: string,
  to: string
): "SWITCH" | "ALREADY_ACTIVE" {
  const active = rows.filter(row => row.enabled)
  if (active.some(row => row.publicId === to && row.gatewayActive && row.modality === "IMAGE"))
    return "ALREADY_ACTIVE"
  if (!active.some(row => row.publicId === from))
    throw new Error("当前启用模型与 --from 不一致，停止切换")
  if (from === to) throw new Error("--from 与 --to 不能相同")
  return "SWITCH"
}

function restoreData(row: any): Prisma.AiGatewayModelUpdateInput {
  const { id: _id, createdAt: _created, updatedAt: _updated, ...data } = row
  return {
    ...data,
    syncedAt: data.syncedAt ? new Date(data.syncedAt) : null,
    quoteConfig: data.quoteConfig === null ? Prisma.DbNull : data.quoteConfig,
  }
}

export async function runModelSwitch(
  db: PrismaClient,
  gateway: AiGatewayClient | null,
  options: {
    from?: string
    to?: string
    apply: boolean
    backup: string
    restore?: string
    priceMultiplier?: string
    fixedCredits?: string
  }
) {
  if (options.restore) {
    const backup = JSON.parse(await readFile(resolve(options.restore), "utf8"))
    if (
      backup.version !== 1 ||
      backup.category !== category ||
      !Array.isArray(backup.before) ||
      !Array.isArray(backup.after) ||
      backup.after.length !== 1 ||
      backup.before.length > 1 ||
      !backup.after[0]?.publicId ||
      backup.after[0].category !== category ||
      backup.before.some(
        (row: any) => row.publicId !== backup.after[0].publicId || row.category !== category
      )
    )
      throw new Error("不是有效的车泰斗模型切换备份")
    return db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM AiGatewayModel WHERE category = ${category} FOR UPDATE`
      const rows = await tx.aiGatewayModel.findMany({
        where: { category, publicId: backup.after[0]?.publicId },
      })
      if (
        fingerprint(rows) !==
        stableHash(
          backup.after.slice().sort((a: any, b: any) => a.publicId.localeCompare(b.publicId))
        )
      )
        throw new Error("模型目录已发生后续变更，拒绝覆盖恢复")
      if (!options.apply) return { dryRun: true, restore: options.restore }
      if (backup.before.length === 0)
        await tx.aiGatewayModel.updateMany({
          where: { category, publicId: backup.after[0].publicId },
          data: { enabled: false },
        })
      for (const row of backup.before)
        await tx.aiGatewayModel.update({
          where: { publicId_category: { publicId: row.publicId, category } },
          data: restoreData(row),
        })
      return { restored: true, retainedNewModelDisabled: true }
    })
  }
  if (!options.from || !options.to)
    throw new Error("必须传 --from=<当前模型> 与 --to=<目标模型>；目标建议 gpt-image-2.5-sunburst")
  if (!gateway) throw new Error("缺少 AI_GATEWAY_API_KEY 或 AI_GATEWAY_BASE_URL")
  const before = await db.aiGatewayModel.findMany({ where: { category } })
  if (assertSwitchSource(before, options.from, options.to) === "ALREADY_ACTIVE")
    return { alreadyActive: true, model: options.to }
  const [detail, requestSchema, quoteConfig] = await Promise.all([
    gateway.models.get(options.to),
    gateway.models.requestSchema(options.to, { operation: "images.generations" }),
    gateway.models.pricing(options.to, { operation: "images.generations" }),
  ])
  if (detail.modality !== "image") throw new Error("目标不是 IMAGE 模型")
  const gatewayConfig = json({ detail, requestSchema })
  // 校验全部公共选项和一个非预设比例，不能只验证 1:1。
  for (const ratio of [...CHETAIDOU_IMAGE_RATIOS, "83:91"])
    for (const tier of CHETAIDOU_IMAGE_TIERS)
      planChetaidouImage(
        { publicId: options.to, gatewayConfig },
        { aspectRatio: ratio, resolutionTier: tier },
        1
      )
  const source = before.find(row => row.publicId === options.from)!
  const target = before.find(row => row.publicId === options.to)
  const price = (raw: string, maximum: number, positive: boolean) => {
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new Error("价格参数必须为最多两位小数的非负数")
    const value = new Decimal(raw)
    if (!value.isFinite() || value.gt(maximum) || (positive && value.lte(0)))
      throw new Error("价格参数超出数据库允许范围")
    return value
  }
  const data = {
    displayName: detail.display_name,
    modality: "IMAGE" as const,
    execMode: detail.exec_mode === "async" ? ("ASYNC" as const) : ("SYNC" as const),
    gatewayConfig,
    quoteConfig: json(quoteConfig),
    gatewayActive: true,
    enabled: true,
    syncedAt: new Date(),
    priceMultiplier:
      options.priceMultiplier !== undefined
        ? price(options.priceMultiplier, 999.99, true)
        : (target?.priceMultiplier ?? source.priceMultiplier),
    fixedCredits:
      options.fixedCredits === "null"
        ? null
        : options.fixedCredits !== undefined
          ? price(options.fixedCredits, 999999.99, false)
          : (target?.fixedCredits ?? (target ? null : source.fixedCredits)),
    sortOrder: target?.sortOrder ?? Math.max(...before.map(row => row.sortOrder)) + 1,
  }
  const preview = {
    model: options.to,
    previousModel: options.from,
    enable: options.to,
    disable: [],
    validatedCombinations: 33,
    schemaVersion: requestSchema.version,
    priceMultiplier: String(data.priceMultiplier),
    fixedCredits: data.fixedCredits === null ? null : String(data.fixedCredits),
  }
  if (!options.apply) return { dryRun: true, ...preview }
  await mkdir(resolve(options.backup, ".."), { recursive: true })
  await db.$transaction(
    async tx => {
      await tx.$queryRaw`SELECT id FROM AiGatewayModel WHERE category = ${category} FOR UPDATE`
      const rows = await tx.aiGatewayModel.findMany({ where: { category } })
      if (fingerprint(rows) !== fingerprint(before))
        throw new Error("模型目录在预检期间发生变更，请重新 dry-run")
      assertSwitchSource(rows, options.from!, options.to!)
      await tx.aiGatewayModel.upsert({
        where: { publicId_category: { publicId: options.to!, category } },
        create: { publicId: options.to!, category, ...data },
        update: data,
      })
      const after = await tx.aiGatewayModel.findMany({ where: { category } })
      const active = after.filter(row => row.enabled)
      if (
        !active.some(
          row => row.publicId === options.to && row.gatewayActive && row.modality === "IMAGE"
        )
      )
        throw new Error("切换后启用模型校验失败，回滚事务")
      // 写备份成功才提交事务；wx 防止覆盖上次备份，文件权限 0600。
      await writeFile(
        resolve(options.backup),
        JSON.stringify(
          {
            version: 1,
            category,
            before: json(before.filter(row => row.publicId === options.to)),
            after: json(after.filter(row => row.publicId === options.to)),
          },
          null,
          2
        ),
        { flag: "wx", mode: 0o600 }
      )
    },
    { timeout: 30_000 }
  )
  return { applied: true, backup: resolve(options.backup), ...preview }
}

async function main() {
  const args = process.argv.slice(2)
  const value = (name: string) =>
    args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  if (args.includes("--help")) {
    console.log(
      "新增可选项（保留现有默认及其他启用模型）：--from=<价格参考模型> --to=gpt-image-2.5-sunburst --dry-run\n执行：相同参数加 --apply --backup=<路径>\n恢复：--restore=<备份路径> --dry-run；确认后改 --apply。恢复保留新增模型行但停用。"
    )
    return
  }
  const apply = args.includes("--apply")
  if (apply && args.includes("--dry-run")) throw new Error("--apply 与 --dry-run 不能同时使用")
  const db = new PrismaClient()
  try {
    const apiKey = process.env.AI_GATEWAY_API_KEY?.trim()
    const baseURL = process.env.AI_GATEWAY_BASE_URL?.trim()
    const gateway =
      apiKey && baseURL
        ? new AiGatewayClient({ apiKey, baseURL, timeoutMs: 30_000, getRetry: { maxRetries: 0 } })
        : null
    console.log(
      JSON.stringify(
        await runModelSwitch(db, gateway, {
          from: value("from"),
          to: value("to"),
          apply,
          restore: value("restore"),
          priceMultiplier: value("priceMultiplier"),
          fixedCredits: value("fixedCredits"),
          backup: value("backup") ?? `seedbackups/chetaidou-image-${Date.now()}.json`,
        }),
        null,
        2
      )
    )
  } finally {
    await db.$disconnect()
  }
}

if (require.main === module)
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
