/** 上线数据初始化：node --env-file-if-exists=.env scripts/init-chetaidou-production.mjs --help */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { ensureThumbnail, configureCors, validateOrigins } from "./chetaidou/storage.mjs"
import { loadBundle, packBundle, digest, readJson, uploadedImageKey } from "./chetaidou/data.mjs"
import { CHETAIDOU_TEXT_MODELS } from "./chetaidou/text-models.mjs"
import { CHETAIDOU_IMAGE_MODELS } from "./chetaidou/image-models.mjs"
import { seedRegistry, ensureFacts, importImage, activateSku, imageImportKey, checkExistingImage, readExistingFacts, readExistingImage, saveModels, resolveImportActor } from "./chetaidou/database.mjs"

const { values: args } = parseArgs({ options: {
  data: { type: "string" }, "pack-from": { type: "string" }, "actor-id": { type: "string" },
  "image-urls": { type: "string" },
  "tool-role": { type: "string", multiple: true }, "admin-role": { type: "string", multiple: true },
  "image-model": { type: "string" },
  "text-multiplier": { type: "string" }, "image-multiplier": { type: "string" }, "image-credits": { type: "string" },
  "dry-run": { type: "boolean" }, "check-data": { type: "boolean" },
  "check-cors": { type: "boolean" }, "allow-origin": { type: "string", multiple: true },
  enable: { type: "boolean" }, help: { type: "boolean" },
} })
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const defaultData = path.join(repository, "scripts/chetaidou/preset-data")
const required = key => {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${key}`)
  return value
}
let imageReader
async function readUploadedImage(url) {
  const bucket = required("SPACES_BUCKET")
  const endpoint = required("SPACES_ENDPOINT")
  const key = uploadedImageKey(url, { bucket, endpoint, baseUrl: process.env.SPACES_BASE_URL })
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3")
  imageReader ??= new S3Client({ endpoint, region: process.env.SPACES_REGION || "us-east-1", credentials: { accessKeyId: required("SPACES_KEY"), secretAccessKey: required("SPACES_SECRET") }, requestHandler: { requestTimeout: 60_000 }, maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" })
  try {
    const object = await imageReader.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    if (!object.Body) throw new Error("图片内容为空")
    return { key, bytes: Buffer.from(await object.Body.transformToByteArray()) }
  } catch (error) {
    throw new Error(`已上传图片读取失败（${error.name ?? "Error"}），请确认上传成功、对象存在且当前环境有读取权限`)
  }
}
function numberOption(key, allowZero = false) {
  if (args[key] === undefined) return undefined
  const value = Number(args[key])
  if (!args[key].trim() || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) throw new Error(`--${key} 必须为${allowZero ? "非负" : "正"}数`)
  return value
}

async function prepareModels(db) {
  const selected = []
  const entries = [
    ...CHETAIDOU_TEXT_MODELS.map((id, sortOrder) => ({ kind: "text", category: "CHETAIDOU_MULTIMODAL", modality: "TEXT", id, sortOrder })),
    { kind: "text", category: "CHETAIDOU_BREAKDOWN", modality: "TEXT", id: "qwen3.8-max", sortOrder: 0 },
    ...(args["image-model"] !== undefined ? [args["image-model"].trim()] : CHETAIDOU_IMAGE_MODELS)
      .map((id, sortOrder) => ({ kind: "image", category: "CHETAIDOU_IMAGE", modality: "IMAGE", id, sortOrder })),
  ]
  for (const { kind, category, modality, id, sortOrder } of entries) {
    const multiplier = numberOption(`${kind}-multiplier`)
    const credits = kind === "image" ? numberOption("image-credits", true) : undefined
    if (!id) {
      throw new Error(`--${kind}-model 不能为空`)
    }
    const old = await db.aiGatewayModel.findUnique({ where: { publicId_category: { publicId: id, category } } })
    if (old) {
      if (!old.enabled || !old.gatewayActive || old.modality !== modality) throw new Error(`${id} 已有配置不可用，初始化不会修改，请在管理端配置`)
      if ((multiplier !== undefined && Number(old.priceMultiplier) !== multiplier) || (credits !== undefined && (credits === 0 ? old.fixedCredits != null : Number(old.fixedCredits) !== credits))) throw new Error(`${id} 已有价格与参数不同，初始化不会修改，请在管理端配置`)
      selected.push({ category, existing: old })
      continue
    }
    if (multiplier === undefined) throw new Error(`新模型需显式提供 --${kind}-multiplier，初始化不猜售价倍率`)
    const { AiGatewayClient } = await import("@zhiqingresearch/ai-ts-sdk")
    const gateway = new AiGatewayClient({ baseURL: required("AI_GATEWAY_BASE_URL"), apiKey: required("AI_GATEWAY_API_KEY"), timeoutMs: 60_000, getRetry: { maxRetries: 0 } })
    const [detail, requestSchema] = await Promise.all([
      gateway.models.get(id), gateway.models.requestSchema(id, { operation: kind === "text" ? "chat.completions" : "images.generations" }),
    ])
    if (detail.modality !== kind) throw new Error(`${id} 模型类型不匹配`)
    if (category === "CHETAIDOU_BREAKDOWN" && detail.facts?.vision !== true) throw new Error(`${id} 未声明拆解所需的视觉能力`)
    if (kind === "image" && (!detail.facts?.modes?.includes("edit") || !requestSchema.request_schema)) throw new Error(`${id} 不支持参考图编辑或缺少请求 Schema`)
    selected.push({ category, data: {
      publicId: id, category, displayName: detail.display_name, modality,
      ...(sortOrder !== undefined ? { sortOrder } : {}),
      execMode: detail.exec_mode === "sync" ? "SYNC" : "ASYNC", enabled: true,
      gatewayActive: true, gatewayConfig: { detail, requestSchema }, syncedAt: new Date(),
      ...(multiplier !== undefined ? { priceMultiplier: multiplier } : {}),
      ...(credits !== undefined ? { fixedCredits: credits === 0 ? null : credits } : {}),
    } })
  }
  return selected
}

async function main() {
  if (args.help) {
    console.log(`车泰斗上线初始化（不调用生成模型、不充值、不创建用户业务任务）
数据打包：--pack-from=<原型仓库> --data=<输出目录>
已上传原图：打包时增加 --image-urls=<imageId到图片URL的JSON清单>，仅输出目录/文档/拆解，不复制图片
默认资料：仓库内 scripts/chetaidou/preset-data（25 张固定原图 URL + 结构化事实卡及来源全文 + 拆解）
资料检查：[--data=<其他目录>] --check-data（URL 图片从当前 Spaces 读回校验，不写库/不上传）
正式导入：[--actor-id=<现有用户ID>] [--enable] [--dry-run] [--data=<其他目录>]
全量初始化：商品/最新版规则事实卡（新库版本 1）+ 25 张母版/拆解/缩略图 + 权限/扣费来源 + 模型/可选角色授权
仅新增初始化资料，不迁移权限、不扫描历史图片、不补齐已有残缺记录
可选跨域：--check-cors 仅读配置；--allow-origin=https://前端域名 追加 GET/HEAD（支持 --dry-run）
省略 --actor-id 时记录为系统初始化（审计 ID=0），不关联个人账号
可选授权：--tool-role=<已有角色code> --admin-role=<已有角色code>（可重复，只追加授权）
文本模型按内置清单全量初始化：${CHETAIDOU_TEXT_MODELS.join("、")}
拆解模型独立登记到 CHETAIDOU_BREAKDOWN：qwen3.8-max
图片模型按内置清单全量初始化：${CHETAIDOU_IMAGE_MODELS.join("、")}
已有配置复用；可选 --image-model=<publicId> 替换本次图片模型清单
新模型价格需显式传 --text-multiplier=<倍率> --image-multiplier=<倍率>
可选 --image-credits=<积分/张，0表示按量>；已有模型只复用，不改价格、不停用其他模型
已有完整资料原样复用；不同事实卡或残缺记录报错，不覆盖、不修复
需要数据库已有最新表结构；默认 URL 原图直接复用，仅为本次新建母版生成缩略图，元数据和拆解写数据库。
初始化母版及配套拆解已确认，导入为 PRESET/CONFIRMED，可直接联想；--enable 仅在全量导入成功后启用 SKU。`)
    return
  }
  validateOrigins(args["allow-origin"])
  if (args["check-data"] && args["pack-from"]) throw new Error("check-data、pack-from 不能同时使用")
  if (args["pack-from"] && !args.data) throw new Error("打包请显式指定 --data=<输出目录>，不能覆盖内置资料")
  if (args["image-urls"] && !args["pack-from"]) throw new Error("--image-urls 需配合 --pack-from 使用；已准备好的 URL 目录直接用 --data")
  if (args["pack-from"] && args["dry-run"]) throw new Error("打包会写本地资料目录，请与初始化 --dry-run 分开执行")
  const root = args.data ? path.resolve(args.data) : defaultData
  if (args["pack-from"]) {
    const imageUrls = args["image-urls"] ? await readJson(path.resolve(args["image-urls"])) : undefined
    await packBundle(path.resolve(args["pack-from"]), root, { imageUrls })
    console.log(`数据包已写入 ${root}`)
  }
  const schema = await import(pathToFileURL(path.join(repository, "dist/chetaidou/chetaidou.schemas.js")).href)
  const bundle = await loadBundle(root, schema.validateBreakdownOutput, { readUploadedImage })
  console.log(`资料校验通过：${bundle.images.length} 张母版、${bundle.images.length} 份已确认拆解、1 份结构化事实卡及来源全文；${bundle.images.filter(i => i.missingBasket).length} 份货篮信息未知。`)
  console.log(`事实卡：规则日期 ${bundle.facts.provenance.rulesDate}；硬约束 ${bundle.facts.hardConstraints.length} 条、资料隔离 ${bundle.facts.dataIsolationRules.length} 条、条件规则 ${bundle.facts.conditionalRules.length} 条、单图参考 ${bundle.facts.imageReferences.length} 条、未知事项 ${bundle.facts.unknowns.length} 条；内容哈希 ${bundle.factsHash}。`)
  if (args["check-data"] || args["pack-from"]) return
  required("DATABASE_URL")
  required("SPACES_KEY"); required("SPACES_SECRET"); required("SPACES_ENDPOINT"); required("SPACES_BUCKET")
  const { PrismaClient } = await import("@prisma/client")
  const db = new PrismaClient()
  try {
    // 预检均为读取，全部通过前不写库、不上传。
    const actorId = await resolveImportActor(db, args["actor-id"])
    console.log(`导入审计：${actorId === 0 ? "系统初始化（ID=0）" : `用户 ID=${actorId}`}。`)
    const grants = {}
    for (const [key, flag] of [["tool.ai_creative_studio.chetaidou", "tool-role"], ["management.chetaidou", "admin-role"]]) {
      const codes = [...new Set(args[flag] ?? [])]
      const roles = await db.roleModel.findMany({ where: { code: { in: codes } } })
      if (roles.length !== codes.length) throw new Error(`--${flag} 包含不存在的角色 code`)
      grants[key] = roles
    }
    const models = await prepareModels(db)
    const oldSku = await db.chetaidouSku.findUnique({ where: { code: bundle.manifest.sku.code } })
    if (oldSku) await readExistingFacts(db, oldSku, bundle.factsHash)
    // 检查将访问的表存在，以及本次资料的导入键是否冲突。
    await db.chetaidouBreakdown.count()
    await db.permission.count(); await db.permissionGroup.count(); await db.featureModule.count()
    for (const image of bundle.images) {
      const row = await db.chetaidouImage.findUnique({ where: { importKey: imageImportKey(bundle.manifest.sku.code, image.entry.id) } })
      checkExistingImage(row, image, oldSku?.id)
      if (row) await readExistingImage(db, row, image)
    }
    console.log(`计划：导入全量资料；模型 ${models.map(m => `${m.category}=${m.existing?.publicId ?? m.data.publicId}`).join("，")}；授权 ${Object.values(grants).flat().length} 项；完成后${args.enable ? "启用" : "保持原有启停状态"}。`)
    if (args["check-cors"] || args["allow-origin"]?.length) {
      const { S3Client } = await import("@aws-sdk/client-s3")
      const s3 = new S3Client({ endpoint: required("SPACES_ENDPOINT"), region: process.env.SPACES_REGION || "us-east-1", credentials: { accessKeyId: required("SPACES_KEY"), secretAccessKey: required("SPACES_SECRET") } })
      try { console.log("CORS：", JSON.stringify(await configureCors(s3, required("SPACES_BUCKET"), args["allow-origin"], !args["dry-run"]))) }
      finally { s3.destroy() }
    }
    if (args["dry-run"]) {
      console.log("预览完成，未写库、未上传、未修改 CORS；对象存储写权限未验证。")
      return
    }
    const registry = await import(pathToFileURL(path.join(repository, "dist/usage/feature-module-definitions.js")).href)
    await seedRegistry(db, registry.FEATURE_MODULE_DEFINITIONS, grants)
    await saveModels(db, models)
    const context = await ensureFacts(db, bundle, actorId)
    const { S3Client, HeadObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3")
    const s3 = new S3Client({ endpoint: required("SPACES_ENDPOINT"), region: process.env.SPACES_REGION || "us-east-1", credentials: { accessKeyId: required("SPACES_KEY"), secretAccessKey: required("SPACES_SECRET") }, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" })
    try {
      const storage = { async ensureFile(key, file, mime, checksum, uploadedBytes) {
        try {
          const head = await s3.send(new HeadObjectCommand({ Bucket: required("SPACES_BUCKET"), Key: key }))
          if (head.Metadata?.sha256 && head.Metadata.sha256 !== checksum) throw new Error("对象存储文件哈希不匹配")
          return
        } catch (error) {
          if (error.$metadata?.httpStatusCode !== 404) throw error
        }
        const bytes = uploadedBytes ?? await readFile(file)
        if (digest(bytes) !== checksum) throw new Error("图片在校验后被修改，已停止上传")
        await s3.send(new PutObjectCommand({ Bucket: required("SPACES_BUCKET"), Key: key, Body: bytes, ContentType: mime, ACL: "private", Metadata: { sha256: checksum } }))
      }, async ensureThumbnail(key, file, uploadedBytes) { return ensureThumbnail(s3, required("SPACES_BUCKET"), key, () => uploadedBytes ?? readFile(file)) } }
      const results = []
      for (const item of bundle.images) {
        const result = await importImage(db, storage, context, item, actorId)
        results.push(result)
        console.log(`[${results.length}/${bundle.images.length}] ${item.entry.id} → imageId=${result.id} ${result.reused ? "原样复用" : "新增"} ${result.qualityStatus}`)
      }
      if (args.enable && results.some(r => r.qualityStatus === "INVALID")) throw new Error("现有母版有已失效拆解，未启用 SKU；请先通过管理端修复")
      if (args.enable) await activateSku(db, context, results.map(r => r.id))
      console.log(`初始化完成：SKU=${context.sku.code}，事实卡=${context.fact.id}，母版及拆解=${results.length}；任务/用户草稿/积分流水未创建。角色授权如未指定，请在管理端分配。`)
    } finally { s3.destroy() }
  } finally { await db.$disconnect() }
}
main().catch(error => { console.error(`初始化失败：${error.message}`); process.exitCode = 1 }).finally(() => imageReader?.destroy())
