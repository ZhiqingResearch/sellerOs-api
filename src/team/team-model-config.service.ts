import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { BatchSaveModelsDto } from "./dto/console.dto"
import { TEAM_MODEL_MODULES, TeamAuditAction } from "./team.constants"

/** resolveModuleModels 返回的模块模型约束（计费层用） */
export interface ModuleModelResolution {
  source: "module" | "global" // 命中模块配置 / 回落团队全局默认
  allowedModels: string[] | null // null=不限制（全局默认不约束可选范围）
  defaultModel: string | null
  memberSelectable: boolean
}

const KIND_LABEL: Record<string, string> = { TEXT: "文本", IMAGE: "生图", VIDEO: "生视频" }

/**
 * 企业级模型配置：AiModel 模型目录（可选池）+ Team.defaultModelText/Image/Video（全局默认）
 * + TeamModelConfig（按功能模块，模块注册表见 TEAM_MODEL_MODULES）。
 * 整页批量保存（batchSave）单事务生效；功能页 UI 约束由前端读配置接口，
 * 计费层默认值/可选范围解析走 resolveModuleModels。
 */
@Injectable()
export class TeamModelConfigService {
  private readonly logger = new Logger(TeamModelConfigService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** 模型目录：在架模型按 kind 分组（配置页选项池） */
  async getCatalog() {
    const models = await this.prisma.aiModel.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { code: true, name: true, kind: true },
    })
    return {
      text: models.filter(m => m.kind === "TEXT"),
      image: models.filter(m => m.kind === "IMAGE"),
      video: models.filter(m => m.kind === "VIDEO"),
    }
  }

  /** 模型配置整页数据：全局默认 + 注册表全部模块（未配置=null，语义=跟随全局默认、成员可自选） */
  async getConfig(teamId: number) {
    const [team, rows] = await Promise.all([
      this.prisma.team.findUniqueOrThrow({
        where: { id: teamId },
        select: { defaultModelText: true, defaultModelImage: true, defaultModelVideo: true },
      }),
      this.prisma.teamModelConfig.findMany({ where: { teamId } }),
    ])
    const byKey = new Map(rows.map(r => [r.moduleKey, r]))
    return {
      defaults: {
        text: team.defaultModelText,
        image: team.defaultModelImage,
        video: team.defaultModelVideo,
      },
      modules: TEAM_MODEL_MODULES.map(def => {
        const row = byKey.get(def.moduleKey)
        return {
          moduleKey: def.moduleKey,
          label: def.label,
          kind: def.kind,
          allowedModels: row ? (row.allowedModels as string[]) : null,
          defaultModel: row?.defaultModel ?? null,
          memberSelectable: row?.memberSelectable ?? true,
        }
      }),
    }
  }

  /**
   * 批量保存：一个请求体覆盖全局默认 + 注册表全部模块，校验通过后单事务整体落库（写审计）。
   * 校验：模块恰好覆盖注册表；全局默认/可选模型均为在架模型且类型匹配；默认模型 ∈ 可选范围。
   */
  async batchSave(teamId: number, actorId: number, dto: BatchSaveModelsDto) {
    const keys = dto.modules.map(m => m.moduleKey)
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException("模块配置存在重复的 moduleKey")
    }
    const missing = TEAM_MODEL_MODULES.filter(d => !keys.includes(d.moduleKey))
    if (missing.length) {
      throw new BadRequestException(`缺少模块配置：${missing.map(d => d.label).join("、")}`)
    }
    const unknown = keys.filter(k => !TEAM_MODEL_MODULES.some(d => d.moduleKey === k))
    if (unknown.length) {
      throw new BadRequestException(`未知的功能模块：${unknown.join("、")}`)
    }

    const catalog = await this.prisma.aiModel.findMany({ where: { active: true } })
    const byCode = new Map(catalog.map(m => [m.code, m]))
    const checkModel = (code: string, kind: string, scene: string) => {
      const m = byCode.get(code)
      if (!m) throw new BadRequestException(`${scene}：模型 ${code} 不存在或已下架`)
      if (m.kind !== kind) {
        throw new BadRequestException(`${scene}：模型 ${code} 不是${KIND_LABEL[kind]}类模型`)
      }
    }
    checkModel(dto.defaults.text, "TEXT", "全局默认")
    checkModel(dto.defaults.image, "IMAGE", "全局默认")
    checkModel(dto.defaults.video, "VIDEO", "全局默认")
    for (const mod of dto.modules) {
      const def = TEAM_MODEL_MODULES.find(d => d.moduleKey === mod.moduleKey)!
      if (!mod.allowedModels.includes(mod.defaultModel)) {
        throw new BadRequestException(`${def.label}：默认模型必须在可选范围内`)
      }
      for (const code of mod.allowedModels) checkModel(code, def.kind, def.label)
    }

    await this.prisma.$transaction(async tx => {
      await tx.team.update({
        where: { id: teamId },
        data: {
          defaultModelText: dto.defaults.text,
          defaultModelImage: dto.defaults.image,
          defaultModelVideo: dto.defaults.video,
        },
      })
      await tx.teamModelConfig.deleteMany({ where: { teamId } })
      await tx.teamModelConfig.createMany({
        data: dto.modules.map(m => ({
          teamId,
          moduleKey: m.moduleKey,
          allowedModels: m.allowedModels,
          defaultModel: m.defaultModel,
          memberSelectable: m.memberSelectable,
        })),
      })
      await tx.teamAuditLog.create({
        data: {
          teamId,
          actorId,
          action: TeamAuditAction.MODEL_CONFIG,
          meta: {
            defaults: dto.defaults,
            modules: dto.modules,
          } as unknown as Prisma.InputJsonValue,
        },
      })
    })
    this.logger.log(`batchSaveModels team=${teamId} modules=${dto.modules.length}`)
    return this.getConfig(teamId)
  }

  /**
   * 计费层公开接口（签名稳定）：解析某功能模块的模型约束。
   * 有模块配置返回之；否则回落团队全局默认（kind 指定 text/image/video 取对应默认模型；
   * 不传 kind 时 defaultModel=null，allowedModels=null 表示不约束可选范围）。
   */
  async resolveModuleModels(
    teamId: number,
    moduleKey: string,
    kind?: "text" | "image" | "video"
  ): Promise<ModuleModelResolution> {
    const config = await this.prisma.teamModelConfig.findUnique({
      where: { teamId_moduleKey: { teamId, moduleKey } },
    })
    if (config) {
      return {
        source: "module",
        allowedModels: config.allowedModels as string[],
        defaultModel: config.defaultModel,
        memberSelectable: config.memberSelectable,
      }
    }
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { defaultModelText: true, defaultModelImage: true, defaultModelVideo: true },
    })
    if (!team) throw new NotFoundException("团队不存在")
    const defaultModel =
      kind === "image"
        ? team.defaultModelImage
        : kind === "video"
          ? team.defaultModelVideo
          : kind === "text"
            ? team.defaultModelText
            : null
    return {
      source: "global",
      allowedModels: null,
      defaultModel: defaultModel ?? null,
      memberSelectable: true,
    }
  }
}
