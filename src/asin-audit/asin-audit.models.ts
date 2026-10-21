import { BadRequestException, Injectable } from "@nestjs/common"
import { AiModelModality } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"

/** ASIN 审计模型目录类别（AiGatewayModel.category，见 prisma/seed 与 onboard 脚本） */
export const ASIN_AUDIT_MODEL_CATEGORY = "ASIN_AUDIT"

/**
 * ASIN 审计模型白名单：请求里的 model 必须命中 AiGatewayModel 目录中
 * category=ASIN_AUDIT、modality=TEXT、enabled、gatewayActive 的行，否则 400。
 * 缺省不兜底——前端从 GET /api/ai-models 目录选择并必传（见方案 §5）。
 */
@Injectable()
export class AsinAuditModels {
  constructor(private readonly prisma: PrismaService) {}

  async assertEnabled(publicId: string): Promise<void> {
    const row = await this.prisma.aiGatewayModel.findFirst({
      where: {
        publicId,
        category: ASIN_AUDIT_MODEL_CATEGORY,
        modality: AiModelModality.TEXT,
        enabled: true,
        gatewayActive: true,
      },
      select: { publicId: true },
    })
    if (!row) {
      throw new BadRequestException({
        code: "ASIN_AUDIT_MODEL_INVALID",
        message: `模型不可用或未在 ${ASIN_AUDIT_MODEL_CATEGORY} 目录上架：${publicId}`,
      })
    }
  }
}
