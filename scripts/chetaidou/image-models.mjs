export const CHETAIDOU_IMAGE_MODELS = [
  "gpt-image-2.5-sunburst",
  "ZQ-Image-1",
]

/** 元数据登记不改现有价格、排序或启停；新项排在已有目录之后。 */
export async function registerImageModel(db, gateway, { publicId = "ZQ-Image-1", enable = false, dryRun = true } = {}) {
  const [detail, requestSchema] = await Promise.all([
    gateway.models.get(publicId),
    gateway.models.requestSchema(publicId, { operation: "images.generations" }),
  ])
  if (detail.modality !== "image" || !detail.facts?.modes?.includes("edit") || !requestSchema.request_schema)
    throw new Error("目标模型不支持参考图编辑或缺少请求 Schema")
  const metadata = { displayName: detail.display_name, modality: "IMAGE", execMode: detail.exec_mode === "sync" ? "SYNC" : "ASYNC",
    gatewayConfig: { detail, requestSchema }, gatewayActive: true, syncedAt: new Date() }
  const execute = async tx => {
    if (!dryRun) await tx.$queryRaw`SELECT id FROM AiGatewayModel WHERE category = 'CHETAIDOU_IMAGE' FOR UPDATE`
    const rows = await tx.aiGatewayModel.findMany({ where: { category: "CHETAIDOU_IMAGE" } })
    const existing = rows.find(row => row.publicId === publicId)
    const where = { publicId_category: { publicId, category: "CHETAIDOU_IMAGE" } }
    if (!dryRun) {
      if (existing) await tx.aiGatewayModel.update({ where, data: metadata })
      else await tx.aiGatewayModel.create({ data: { ...metadata, publicId, category: "CHETAIDOU_IMAGE", enabled: enable,
        sortOrder: rows.length ? Math.max(...rows.map(row => row.sortOrder)) + 1 : 0 } })
    }
    return { publicId, displayName: detail.display_name, dryRun, action: existing ? "sync" : "create", enabled: existing?.enabled ?? enable }
  }
  return dryRun ? execute(db) : db.$transaction(execute)
}
