import { PrismaClient } from "@prisma/client"
import { LOCAL_REDRAW_CATEGORY } from "../../src/image-generation/local-redraw.constants"

/** 仅初始化局部重绘分类；不修改通用生图配置或覆盖已有局部重绘定价。 */
export async function seedLocalRedrawModel(prisma: PrismaClient) {
  const existing = await prisma.aiGatewayModel.findFirst({ where: { category: LOCAL_REDRAW_CATEGORY } })
  if (existing) return { created: false }
  const source = await prisma.aiGatewayModel.findFirst({
    where: { category: "IMAGE_GENERATION", modality: "IMAGE", enabled: true, gatewayActive: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  })
  if (!source?.enabled || !source.gatewayActive || source.modality !== "IMAGE") {
    throw new Error("请先上架 IMAGE_GENERATION 分类的可用图片模型并同步网关能力")
  }
  const key = { publicId: source.publicId, category: LOCAL_REDRAW_CATEGORY }
  await prisma.aiGatewayModel.upsert({
    where: { publicId_category: key },
    update: {},
    create: {
      ...key,
      displayName: source.displayName,
      modality: source.modality,
      execMode: source.execMode,
      gatewayConfig: source.gatewayConfig!,
      priceMultiplier: source.priceMultiplier,
      fixedCredits: source.fixedCredits,
      enabled: true,
      gatewayActive: true,
      syncedAt: source.syncedAt,
      ...(source.quoteConfig ? { quoteConfig: source.quoteConfig } : {}),
    },
  })
  return { created: true }
}
