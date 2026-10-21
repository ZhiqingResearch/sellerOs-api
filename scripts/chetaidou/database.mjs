import { jsonHash, presetAcceptance } from "./data.mjs"

// 仅离线初始化可用 0 表示系统；HTTP 维护接口仍记录登录用户。
export async function resolveImportActor(db, value) {
  if (value === undefined) return 0
  const actorId = Number(value)
  if (!Number.isSafeInteger(actorId) || actorId <= 0) throw new Error("--actor-id 必须是现有启用用户的正整数 ID；系统初始化请省略该参数")
  const actor = await db.user.findUnique({ where: { id: actorId }, select: { isActive: true } })
  if (!actor?.isActive) throw new Error("审计用户不存在或已停用")
  return actorId
}

export const permissions = [
  { key: "tool.ai_creative_studio.chetaidou", label: "车泰斗素材工作台", groupCode: "tools", parentKey: "tool.ai_creative_studio", route: "/chetaidou", sortOrder: 12 },
  { key: "management.chetaidou", label: "车泰斗资料维护", groupCode: "management", route: "/chetaidou-admin", sortOrder: 11 },
]
export async function seedRegistry(db, features, grants) {
  for (const [i, p] of permissions.entries()) {
    await db.permissionGroup.upsert({ where: { code: p.groupCode }, update: {}, create: {
      code: p.groupCode, label: i === 0 ? "工具" : "管理", sortOrder: i + 1, isBuiltin: true,
    } })
    const permission = await db.permission.upsert({ where: { key: p.key }, update: {}, create: { ...p, subRoutes: [] } })
    for (const role of grants[p.key] ?? []) {
      await db.rolePermission.upsert({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } }, update: {}, create: { roleId: role.id, permissionId: permission.id } })
    }
  }
  for (const f of features.filter(f => f.source.startsWith("chetaidou."))) {
    await db.featureModule.upsert({ where: { source: f.source }, update: {}, create: f })
  }
}

/** 初始化模型只新增；已有配置保持原样，同分类冲突不自动停用。 */
export async function saveModels(db, models) {
  for (const model of models.filter(m => m.data)) {
    await db.$transaction(async tx => {
      const existing = await tx.aiGatewayModel.findUnique({ where: { publicId_category: { publicId: model.data.publicId, category: model.category } } })
      if (existing) throw new Error("模型配置在预检后发生变化，请重新执行")
      await tx.aiGatewayModel.create({ data: model.data })
    })
  }
}

export async function readExistingFacts(db, sku, factsHash) {
  const fact = sku.currentFactId ? await db.chetaidouFactCard.findUnique({ where: { id: sku.currentFactId } }) : null
  if (!fact || fact.skuId !== sku.id) throw new Error("已有 SKU 事实卡关联缺失或损坏，初始化不会补齐")
  if (fact.contentHash !== factsHash || jsonHash(fact.content) !== factsHash) throw new Error("已有不同事实卡，初始化不会覆盖，请在管理端维护")
  return fact
}

export async function ensureFacts(db, bundle, actorId) {
  const acceptance = presetAcceptance(bundle.manifest)
  // 新 SKU 与事实卡同事务创建，中断不会留下等待补齐的空关联。
  return db.$transaction(async tx => {
    const existing = await tx.chetaidouSku.findUnique({ where: { code: bundle.manifest.sku.code } })
    if (existing) return { sku: existing, fact: await readExistingFacts(tx, existing, bundle.factsHash), acceptance }
    const sku = await tx.chetaidouSku.create({ data: { ...bundle.manifest.sku, enabled: false } })
    const fact = await tx.chetaidouFactCard.create({ data: {
      skuId: sku.id, version: 1, content: bundle.facts,
      contentHash: bundle.factsHash, confirmedBy: actorId, confirmedAt: new Date(),
    } })
    await tx.chetaidouSku.update({ where: { id: sku.id }, data: { currentFactId: fact.id, revision: { increment: 1 } } })
    return { sku, fact, acceptance }
  }, { timeout: 30_000 })
}

export function imageImportKey(code, id) { return `chetaidou:seed:${code}:${id}` }
export function checkExistingImage(image, item, skuId) {
  if (image && (image.skuId !== skuId || image.sourceType !== "PRESET" || image.ownerId !== null || image.checksum !== item.checksum)) {
    throw new Error(`${item.entry.id} 已绑定不同图片或归属，停止覆盖`)
  }
}

export async function readExistingImage(db, image, item) {
  const current = image.currentBreakdownId ? await db.chetaidouBreakdown.findUnique({ where: { id: image.currentBreakdownId } }) : null
  if (!current || current.imageId !== image.id || !image.sourceMetadata?.thumbnailKey) throw new Error(`${item.entry.id} 已有记录缺少拆解或缩略图，初始化不会补齐`)
  return { id: image.id, reused: true, qualityStatus: current.qualityStatus }
}

/** 仅创建本次清单的新母版；图片与拆解同事务入库，已有记录只读。 */
export async function importImage(db, storage, context, item, actorId) {
  const { sku, fact } = context
  const key = imageImportKey(sku.code, item.entry.id)
  const lookup = client => client.chetaidouImage.findUnique({ where: { importKey: key } })
  const existing = await lookup(db)
  checkExistingImage(existing, item, sku.id)
  if (existing) return readExistingImage(db, existing, item)
  const fileKey = item.uploadedKey ?? `chetaidou/${sku.id}/preset/seed/${item.entry.id}/${item.checksum}.${item.mime.split("/")[1]}`
  if (!item.uploadedKey) await storage.ensureFile(fileKey, item.file, item.mime, item.checksum, item.bytes)
  const thumbnailKey = await storage.ensureThumbnail(fileKey, item.file, item.bytes)
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM ChetaidouSku WHERE id = ${sku.id} FOR UPDATE`
    const latestSku = await tx.chetaidouSku.findUniqueOrThrow({ where: { id: sku.id } })
    if (latestSku.currentFactId !== fact.id) throw new Error("事实卡在导入期间发生变化，请重新执行")
    const concurrent = await lookup(tx)
    checkExistingImage(concurrent, item, sku.id)
    if (concurrent) return readExistingImage(tx, concurrent, item)
    const image = await tx.chetaidouImage.create({ data: {
      skuId: sku.id, sourceType: "PRESET", ownerId: null, createdBy: actorId,
      title: item.entry.title, number: String(item.entry.number ?? ""), fileKey,
      mime: item.mime, width: item.width, height: item.height, checksum: item.checksum,
      importKey: key, sourceMetadata: { ...item.entry, initializer: "chetaidou-production-v1", thumbnailKey },
    } })
    const hash = jsonHash(item.payload)
    const breakdown = await tx.chetaidouBreakdown.create({ data: {
      imageId: image.id, version: 1, factId: fact.id,
      source: "PRESET", qualityStatus: "CONFIRMED", confirmedBy: actorId, confirmedAt: new Date(), payload: item.payload,
      schemaVersion: item.missingBasket ? 0 : 1, contentHash: hash, importKey: `${key}:bk:${fact.id}:${hash}`,
      sourceMetadata: { initializer: "chetaidou-production-v1", importedBy: actorId, acceptance: context.acceptance, sourceHash: item.raw.sourceHash, sourceVersion: item.raw.version ?? null, originalBreakdown: item.raw, missingFields: item.missingBasket ? ["basketContents"] : [] },
    } })
    await tx.chetaidouImage.update({ where: { id: image.id }, data: { currentBreakdownId: breakdown.id, revision: { increment: 1 } } })
    return { id: image.id, reused: false, qualityStatus: "CONFIRMED" }
  }, { timeout: 30_000 })
}

export async function activateSku(db, context, imageIds) {
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM ChetaidouSku WHERE id = ${context.sku.id} FOR UPDATE`
    const current = await tx.chetaidouSku.findUniqueOrThrow({ where: { id: context.sku.id } })
    if (current.currentFactId !== context.fact.id) throw new Error("事实卡已变化，未启用 SKU")
    const count = await tx.chetaidouImage.count({ where: { id: { in: imageIds }, skuId: current.id, enabled: true, currentBreakdownId: { not: null } } })
    if (count !== imageIds.length) throw new Error("母版未全部就绪，未启用 SKU")
    if (!current.enabled) await tx.chetaidouSku.update({ where: { id: current.id }, data: { enabled: true, revision: { increment: 1 } } })
  })
}
