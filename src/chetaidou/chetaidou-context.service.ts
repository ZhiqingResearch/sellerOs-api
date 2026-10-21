// 车泰斗素材工作台 — 资料解析、任务快照与上下文指纹（方案 §4）
// Task.snapshot 是不可变执行输入：模板正文随快照冻结，部署后旧排队任务
// 仍用其冻结版本执行；新资料不修改已提交任务。
import { BadRequestException, Injectable } from "@nestjs/common"
import { PrismaService } from "../prisma/prisma.service"
import {
  contentSettingsOf,
  dimensionRangeOf,
  IDEATION_BATCH_SIZE,
  IDEATION_BATCH_VERSION,
  optionRangeOf,
} from "./chetaidou-execution"
import { stableHash } from "./chetaidou-storage.service"
import {
  CHETAIDOU_BREAKDOWN_CATEGORY,
  CHETAIDOU_ERROR_CODES,
  CHETAIDOU_IMAGE_CATEGORY,
  CHETAIDOU_TEXT_CATEGORY,
  chetaidouRepairBudget,
} from "./chetaidou.constants"
import { CHETAIDOU_PROMPT_VERSION, CHETAIDOU_TEMPLATE_BODIES } from "./chetaidou.prompts"
import { ChetaidouBreakdownPayload, ChetaidouSettings } from "./chetaidou.schemas"

export interface TaskSnapshot {
  workflow?: { workspaceId: string | null; adjustmentId: string | null }
  schemaVersion: 1
  parserVersion: string
  image: {
    id: number
    skuId: number
    fileKey: string
    checksum: string
    width: number
    height: number
    mime: string
  }
  facts: { id: number; version: number; content: unknown; contentHash: string }
  breakdown: {
    id: number
    version: number
    payload: ChetaidouBreakdownPayload
    contentHash: string
  } | null
  settings: ChetaidouSettings
  resolvedSelections: unknown[]
  customDimensions: unknown[]
  activeGroupRefs?: { groupId: string }[]
  refresh?: {
    parentGroupId: string
    definition: unknown
    retainedOptions: unknown[]
    history: unknown[]
    sourceIdeationTaskId: string
  }
  decisions: unknown[]
  prompt: { version: string; templateBodies: Record<string, string> }
  models: {
    text: { publicId: string; category: string }
    image: { publicId: string; category: string }
  }
  limits: { repairBudget: number }
  execution?: { version: typeof IDEATION_BATCH_VERSION; batchSize: number }
  composition?: { taskId: string; editPromptEn: string }
  edit?: { sourceResultId: number; sourceTaskId: string; width: number; height: number }
  generation?: { count: number; quality?: string; resolution: string } & Partial<
    import("./chetaidou-image-options.service").ImageGenerationPlan
  >
}

@Injectable()
export class ChetaidouContextService {
  constructor(private readonly prisma: PrismaService) {}

  /** 文本和图片按冻结选择或目录排序默认值解析；重试不换模型。 */
  async resolveModels(
    frozen?: TaskSnapshot["models"],
    textModel?: string,
    textCategory = CHETAIDOU_TEXT_CATEGORY
  ): Promise<TaskSnapshot["models"]> {
    const resolve = async (kind: "text" | "image", category: string) => {
      const selected =
        frozen?.[kind] ??
        (kind === "text" && textModel ? { publicId: textModel, category } : undefined)
      const rows = await this.prisma.aiGatewayModel.findMany({
        where: {
          category: selected?.category ?? category,
          modality: kind === "text" ? "TEXT" : "IMAGE",
          enabled: true,
          gatewayActive: true,
          ...(selected ? { publicId: selected.publicId } : {}),
        },
        select: { publicId: true, category: true },
        orderBy: [{ sortOrder: "asc" as const }, { id: "asc" as const }],
        take: 1,
      })
      if (rows.length === 0) {
        throw new BadRequestException({
          message:
            selected && kind === "image"
              ? "该任务原生图模型已停用或不可用，请使用当前配置重新生成"
              : `车泰斗模型未配置或未启用：${selected?.category ?? category}`,
          code: CHETAIDOU_ERROR_CODES.MODEL_NOT_READY,
        })
      }
      return rows[0]
    }
    const [text, image] = await Promise.all([
      resolve("text", textCategory),
      resolve("image", CHETAIDOU_IMAGE_CATEGORY),
    ])
    return { text, image }
  }

  /** 拆解独立配置，避免联想等文本阶段的默认模型影响拆解。 */
  async resolveBreakdownModels(): Promise<TaskSnapshot["models"]> {
    return this.resolveModels(undefined, undefined, CHETAIDOU_BREAKDOWN_CATEGORY)
  }

  /** 读当前生效资料组合（SKU 必须启用且有 facts；image 必须可用） */
  async loadCurrentContext(skuId: number, imageId: number) {
    const sku = await this.prisma.chetaidouSku.findUnique({ where: { id: skuId } })
    if (!sku || !sku.enabled) throw new Error("SKU 不存在或未启用")
    if (!sku.currentFactId) throw new Error("SKU 尚未发布事实卡")
    const fact = await this.prisma.chetaidouFactCard.findUnique({
      where: { id: sku.currentFactId },
    })
    if (!fact) throw new Error("事实卡缺失")
    const image = await this.prisma.chetaidouImage.findUnique({ where: { id: imageId } })
    if (!image || image.skuId !== skuId || !image.enabled) throw new Error("母版不存在或不可用")
    const breakdown = image.currentBreakdownId
      ? await this.prisma.chetaidouBreakdown.findUnique({
          where: { id: image.currentBreakdownId },
        })
      : null
    if (breakdown && breakdown.imageId !== imageId) throw new Error("拆解归属不符")
    return { sku, fact, image, breakdown }
  }

  /** 构建完整任务快照（按 type 裁剪字段） */
  async buildSnapshot(input: {
    models?: TaskSnapshot["models"]
    image: {
      id: number
      skuId: number
      fileKey: string
      checksum: string
      width: number
      height: number
      mime: string
    }
    fact: { id: number; version: number; content: unknown; contentHash: string }
    breakdown: { id: number; version: number; payload: unknown; contentHash: string } | null
    settings: unknown
    resolvedSelections?: unknown
    customDimensions?: unknown
    activeGroupRefs?: unknown
    refresh?: TaskSnapshot["refresh"]
    decisions?: unknown
    composition?: TaskSnapshot["composition"]
    generation?: TaskSnapshot["generation"]
  }): Promise<TaskSnapshot> {
    const settings = input.settings as ChetaidouSettings
    const models = input.models ?? (await this.resolveModels(undefined, settings.model))
    return {
      schemaVersion: 1,
      parserVersion: CHETAIDOU_PROMPT_VERSION,
      image: input.image,
      facts: input.fact,
      breakdown: input.breakdown as TaskSnapshot["breakdown"],
      settings: {
        ...settings,
        model: models.text.publicId,
        dimensionCountRange: dimensionRangeOf(settings),
        optionCountRange: optionRangeOf(settings),
      },
      resolvedSelections: (input.resolvedSelections as unknown[]) ?? [],
      customDimensions: (input.customDimensions as unknown[]) ?? [],
      activeGroupRefs: input.activeGroupRefs as { groupId: string }[] | undefined,
      refresh: input.refresh,
      decisions: (input.decisions as unknown[]) ?? [],
      prompt: { version: CHETAIDOU_PROMPT_VERSION, templateBodies: CHETAIDOU_TEMPLATE_BODIES },
      models,
      execution: { version: IDEATION_BATCH_VERSION, batchSize: IDEATION_BATCH_SIZE },
      limits: { repairBudget: chetaidouRepairBudget() },
      composition: input.composition,
      generation: input.generation,
    }
  }

  /**
   * 分阶段上下文指纹：联想看 image/facts/breakdown/settings；
   * 组合另加真实选项、手写内容和 decisions（方案 §4.3）。
   */
  contextHash(
    stage: "ideation" | "compose" | "generate" | "diverge" | "refresh",
    ctx: TaskSnapshot
  ): string {
    const base = {
      image: ctx.image.checksum,
      facts: ctx.facts.contentHash,
      breakdown: ctx.breakdown?.contentHash ?? null,
      settings: contentSettingsOf(ctx.settings),
    }
    if (stage === "compose" || stage === "generate") {
      return stableHash({
        ...base,
        resolvedSelections: ctx.resolvedSelections,
        customDimensions: ctx.customDimensions,
        decisions: ctx.decisions,
      })
    }
    if (stage === "refresh") {
      return stableHash({ ...base, refresh: ctx.refresh })
    }
    return stableHash(base)
  }

  /** 用户请求幂等 hash：含动作、资源 ID、预期版本、目标、count、输入 */
  requestHash(payload: unknown): string {
    return stableHash(payload)
  }
}
