export const CHETAIDOU_TEXT_MODELS = ["qwen3.8-max"]

/** 仅读取网关元数据，不发起生成调用。预检全部模型后才允许写库。 */
export async function prepareTextModels(gateway, publicIds = CHETAIDOU_TEXT_MODELS, category = "CHETAIDOU_MULTIMODAL") {
  return Promise.all(publicIds.map(async (publicId, sortOrder) => {
    const [detail, requestSchema] = await Promise.all([
      gateway.models.get(publicId),
      gateway.models.requestSchema(publicId, { operation: "chat.completions" }),
    ])
    if (detail.modality !== "text" || !detail.display_name?.trim())
      throw new Error(`${publicId} 网关类型或展示名称无效`)
    return {
      publicId, category, modality: "TEXT",
      displayName: detail.display_name,
      execMode: detail.exec_mode === "sync" ? "SYNC" : "ASYNC",
      gatewayConfig: { detail, requestSchema }, gatewayActive: true,
      syncedAt: new Date(), sortOrder,
    }
  }))
}

export async function syncTextModels(db, models, { dryRun = false, enable = false, multiplier, setDefault = false } = {}) {
  if (multiplier !== undefined && (!Number.isFinite(multiplier) || multiplier <= 0))
    throw new Error("新增模型售价倍率必须为正数")
  if (setDefault && !enable) throw new Error("设置默认模型须同时传 --enable")
  if (setDefault && models.length !== 1) throw new Error("设置默认模型时只能指定一个模型")
  if (setDefault && models[0].gatewayConfig?.detail?.facts?.vision !== true)
    throw new Error("默认拆解模型必须声明视觉能力")
  const execute = async tx => {
    const results = []
    for (const model of models) {
      const where = { publicId_category: { publicId: model.publicId, category: model.category } }
      const existing = await tx.aiGatewayModel.findUnique({ where })
      if (!existing && multiplier === undefined) throw new Error(`${model.publicId} 是新配置，请显式指定 --multiplier`)
      results.push({ publicId: model.publicId, category: model.category, displayName: model.displayName, action: existing ? "sync" : "create", ...(setDefault ? { isDefault: true, sortOrder: 0 } : {}) })
      if (dryRun) continue
      if (existing) {
        const { sortOrder, ...metadata } = model
        void sortOrder
        await tx.aiGatewayModel.update({ where, data: { ...metadata, ...(enable ? { enabled: true } : {}), ...(setDefault ? { sortOrder: 0 } : {}) } })
      } else {
        await tx.aiGatewayModel.create({ data: { ...model, enabled: enable, priceMultiplier: multiplier, ...(setDefault ? { sortOrder: 0 } : {}) } })
      }
      if (setDefault) {
        await tx.aiGatewayModel.updateMany({
          where: { category: model.category, modality: "TEXT", enabled: true, publicId: { not: model.publicId }, sortOrder: { lte: 0 } },
          data: { sortOrder: 1 },
        })
      }
    }
    return results
  }
  return dryRun ? execute(db) : db.$transaction(execute, { timeout: 60_000 })
}
