export const CHETAIDOU_TEXT_MODELS = [
  "ZQ-Multimodal-Gemini-3.7-Flash",
  "ZQ-Multimodal-Gemini-3.8-Flash",
]

/** 仅读取网关元数据，不发起生成调用。预检全部模型后才允许写库。 */
export async function prepareTextModels(gateway, publicIds = CHETAIDOU_TEXT_MODELS) {
  return Promise.all(publicIds.map(async (publicId, sortOrder) => {
    const [detail, requestSchema] = await Promise.all([
      gateway.models.get(publicId),
      gateway.models.requestSchema(publicId, { operation: "chat.completions" }),
    ])
    if (detail.modality !== "text" || !detail.display_name?.trim())
      throw new Error(`${publicId} 网关类型或展示名称无效`)
    return {
      publicId, category: "CHETAIDOU_MULTIMODAL", modality: "TEXT",
      displayName: detail.display_name,
      execMode: detail.exec_mode === "sync" ? "SYNC" : "ASYNC",
      gatewayConfig: { detail, requestSchema }, gatewayActive: true,
      syncedAt: new Date(), sortOrder,
    }
  }))
}

export async function syncTextModels(db, models, { dryRun = false, enable = false, multiplier } = {}) {
  if (multiplier !== undefined && (!Number.isFinite(multiplier) || multiplier <= 0))
    throw new Error("新增模型售价倍率必须为正数")
  const execute = async tx => {
    const results = []
    for (const model of models) {
      const where = { publicId_category: { publicId: model.publicId, category: model.category } }
      const existing = await tx.aiGatewayModel.findUnique({ where })
      if (!existing && multiplier === undefined) throw new Error(`${model.publicId} 是新配置，请显式指定 --multiplier`)
      results.push({ publicId: model.publicId, displayName: model.displayName, action: existing ? "sync" : "create" })
      if (dryRun) continue
      if (existing) {
        const { sortOrder, ...metadata } = model
        void sortOrder
        await tx.aiGatewayModel.update({ where, data: { ...metadata, ...(enable ? { enabled: true } : {}) } })
      } else {
        await tx.aiGatewayModel.create({ data: { ...model, enabled: enable, priceMultiplier: multiplier } })
      }
    }
    return results
  }
  return dryRun ? execute(db) : db.$transaction(execute, { timeout: 60_000 })
}
