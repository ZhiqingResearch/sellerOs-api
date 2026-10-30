/** 仅初始化专属分类，默认 dry-run；--apply 才写库。既有分类与既有目标行均不覆盖。 */
import { Prisma, PrismaClient } from "@prisma/client"
import { parse } from "dotenv"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  DOMESTIC_BUSINESS_MODELS,
  DOMESTIC_BUSINESS_MODEL_CATEGORY,
} from "../src/common/business-ai/domestic-business-models"

const prisma = new PrismaClient()
const sourceEnvIndex = process.argv.indexOf("--source-env")
const sourceUrl =
  sourceEnvIndex >= 0
    ? parse(readFileSync(process.argv[sourceEnvIndex + 1], "utf8")).DATABASE_URL
    : process.env.DATABASE_URL
if (!sourceUrl) throw new Error("源数据库配置缺少 DATABASE_URL")
const sourcePrisma = new PrismaClient({ datasourceUrl: sourceUrl })
const isApply = process.argv.includes("--apply")
const hashRows = (rows: unknown) => createHash("sha256").update(JSON.stringify(rows)).digest("hex")

async function main() {
  const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1)
  const before = await prisma.aiGatewayModel.findMany({
    where: { category: { not: DOMESTIC_BUSINESS_MODEL_CATEGORY } },
    orderBy: { id: "asc" },
  })
  const sources = await sourcePrisma.aiGatewayModel.findMany({
    where: {
      category: "TEXT",
      publicId: { in: [...DOMESTIC_BUSINESS_MODELS] },
      modality: "TEXT",
    },
  })
  const results = await prisma.$transaction(
    async tx => {
      const existing = await tx.aiGatewayModel.findMany({
        where: { category: DOMESTIC_BUSINESS_MODEL_CATEGORY },
      })
      if (existing.some(row => !DOMESTIC_BUSINESS_MODELS.some(model => model === row.publicId)))
        throw new Error("目标分类已包含范围外模型，请核对；脚本不会删除或覆盖记录")
      const results: object[] = []
      for (const publicId of DOMESTIC_BUSINESS_MODELS) {
        const current = existing.find(row => row.publicId === publicId)
        if (current) {
          results.push({
            publicId,
            action: "skipped",
            enabled: current.enabled,
            gatewayActive: current.gatewayActive,
          })
          continue
        }
        const source = sources.find(row => row.publicId === publicId)
        if (!source || !source.enabled || !source.gatewayActive)
          throw new Error(`源 TEXT 分类缺少已启用的 ${publicId}，不写入不完整配置`)
        if (isApply)
          await tx.aiGatewayModel.create({
            data: {
              publicId,
              category: DOMESTIC_BUSINESS_MODEL_CATEGORY,
              displayName: source.displayName,
              modality: source.modality,
              execMode: source.execMode,
              gatewayConfig: source.gatewayConfig as Prisma.InputJsonValue,
              quoteConfig:
                source.quoteConfig === null
                  ? Prisma.DbNull
                  : (source.quoteConfig as Prisma.InputJsonValue),
              priceMultiplier: source.priceMultiplier,
              fixedCredits: source.fixedCredits,
              gatewayActive: source.gatewayActive,
              syncedAt: source.syncedAt,
              enabled: source.enabled,
              sortOrder: source.sortOrder,
            },
          })
        results.push({
          publicId,
          action: isApply ? "created" : "would-create",
          sourceId: source.id,
        })
      }
      return results
    },
    { timeout: 20000 }
  )
  const after = await prisma.aiGatewayModel.findMany({
    where: { category: { not: DOMESTIC_BUSINESS_MODEL_CATEGORY } },
    orderBy: { id: "asc" },
  })
  console.log(
    JSON.stringify(
      {
        database,
        category: DOMESTIC_BUSINESS_MODEL_CATEGORY,
        isApply,
        results,
        otherCategoriesUnchanged: hashRows(before) === hashRows(after),
      },
      null,
      2
    )
  )
}
main()
  .catch(error => {
    console.error(
      error instanceof Error ? error.message.replace(/mysql:\/\/\S+/g, "[redacted]") : "初始化失败"
    )
    process.exitCode = 1
  })
  .finally(() => Promise.all([prisma.$disconnect(), sourcePrisma.$disconnect()]))
