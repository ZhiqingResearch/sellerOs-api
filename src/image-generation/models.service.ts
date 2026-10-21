// src/image-generation/models.service.ts
//
// 生图模型下拉的唯一数据源 —— 与其他模块同口径,统一读 AiGatewayModel
// 本地目录(modality=IMAGE + category=IMAGE_GENERATION + enabled +
// gatewayActive),读时经 AiGatewayModelService.maybeRefreshModels 触发
// 后台刷新(按 syncedAt 30 分钟节流)。上架:scripts/onboard-ai-gateway-
// image-model.ts 人工建行;网关下架由刷新置 gatewayActive=false 隐藏。

import { Injectable, Logger } from "@nestjs/common";
import { AiModelModality } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { AiGatewayModelService } from "../ai-gateway/ai-gateway-model.service";
import { PrismaService } from "../prisma/prisma.service";
import { UsageService } from "../usage/usage.service";
import { resolveGatewayModel } from "./providers/gateway-mapping";

/** 通用生图在 AiGatewayModel 中的业务类别(category) */
export const IMAGE_GENERATION_MODEL_CATEGORY = "IMAGE_GENERATION";

const pricingLogger = new Logger("ImageGenerationPricing");

/**
 * 读取通用生图固定一口价（积分/张）：AiGatewayModel.fixedCredits（IMAGE_GENERATION 行），
 * 逻辑 ID 先经 resolveGatewayModel 解析到网关 model。实时读库，改库即时生效；
 * 未配置（NULL/缺行/禁用）返回 null → 调用方不预检、执行器回落按量计费；查询失败同样返回 null。
 */
export async function loadImageGenerationFixedCredits(
  usage: UsageService,
  provider: string,
  category = IMAGE_GENERATION_MODEL_CATEGORY,
): Promise<Decimal | null> {
  try {
    return await usage.gatewayFixedImageCredits(
      resolveGatewayModel(provider) ?? provider,
      category,
    );
  } catch (err) {
    pricingLogger.error(
      `[image-gen-pricing] failed to load fixed credits (fallback usage-based): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export interface ImageGenerationModelEntry {
  id: string;
  label: string;
  backend: "gateway" | "direct";
  /** 固定一口价（积分/张）：null = 未配置，前端不展示一口价（后端按量计费） */
  fixedCredits: string | null;
}

@Injectable()
export class ImageGenerationModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: AiGatewayModelService,
  ) {}

  async list(): Promise<ImageGenerationModelEntry[]> {
    void this.catalog.maybeRefreshModels(
      AiModelModality.IMAGE,
      IMAGE_GENERATION_MODEL_CATEGORY,
    );
    const models = await this.prisma.aiGatewayModel.findMany({
      where: {
        modality: AiModelModality.IMAGE,
        category: IMAGE_GENERATION_MODEL_CATEGORY,
        enabled: true,
        gatewayActive: true,
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { publicId: true, displayName: true, fixedCredits: true },
    });
    return models.map((m) => ({
      id: m.publicId,
      label: m.displayName,
      backend: "gateway" as const,
      fixedCredits: m.fixedCredits ? m.fixedCredits.toString() : null,
    }));
  }
}
