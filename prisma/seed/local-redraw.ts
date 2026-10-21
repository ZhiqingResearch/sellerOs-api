import { PrismaClient } from "@prisma/client"
import {
  LOCAL_REDRAW_CATEGORY,
  LOCAL_REDRAW_MODEL,
} from "../../src/image-generation/local-redraw.constants"

/** 仅初始化局部重绘分类；不修改通用生图配置或覆盖已有局部重绘定价。 */
export async function seedLocalRedrawModel(prisma: PrismaClient) {
  const key = { publicId: LOCAL_REDRAW_MODEL, category: LOCAL_REDRAW_CATEGORY }
  const existing = await prisma.aiGatewayModel.findUnique({ where: { publicId_category: key } })
  if (existing) return { created: false }
  const source = await prisma.aiGatewayModel.findUnique({
    where: { publicId_category: { publicId: LOCAL_REDRAW_MODEL, category: "IMAGE_GENERATION" } },
  })
  if (!source?.enabled || !source.gatewayActive || source.modality !== "IMAGE") {
    throw new Error("请先上架 IMAGE_GENERATION 分类的 ZQ-Image-2 并同步网关能力")
  }
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
