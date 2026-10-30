import { BadRequestException, Injectable } from "@nestjs/common"
import { AiModelModality } from "@prisma/client"
import { PrismaService } from "../../prisma/prisma.service"

export const DOMESTIC_BUSINESS_MODELS = ["qwen3.8-max", "MiniMax-M3"] as const
export const DOMESTIC_BUSINESS_MODEL_CATEGORY = "SELLER_BUSINESS"

/** 仅供 Listing（含一键上架）、竞品分析、新品推广、智能定价使用。 */
@Injectable()
export class DomesticBusinessModels {
  constructor(private readonly prisma: PrismaService) {}

  async assertEnabled(publicId: unknown): Promise<void> {
    if (
      typeof publicId !== "string" ||
      !DOMESTIC_BUSINESS_MODELS.some(model => model === publicId)
    ) {
      throw new BadRequestException("请选择 qwen3.8-max 或 MiniMax-M3 模型")
    }
    const row = await this.prisma.aiGatewayModel.findFirst({
      where: {
        publicId,
        category: DOMESTIC_BUSINESS_MODEL_CATEGORY,
        modality: AiModelModality.TEXT,
        enabled: true,
        gatewayActive: true,
      },
      select: { publicId: true },
    })
    if (!row) throw new BadRequestException("所选模型未启用或当前不可用，请重新选择")
  }
}
