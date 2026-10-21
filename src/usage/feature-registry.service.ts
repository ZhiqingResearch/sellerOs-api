import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { PrismaService } from "../prisma/prisma.service"
import { FEATURE_MODULE_DEFINITIONS } from "./feature-module-definitions"
import {
  getRegisteredFeature,
  listRegisteredFeatures,
  RegisteredFeature,
  setFeatureRegistryCache,
} from "./usage-source-labels"

/** 注册表缓存刷新间隔：seed 导入新功能后最长 1 分钟生效，免重启 */
const REGISTRY_TTL_MS = 60_000

/**
 * FeatureModule 注册表（功能模块单一事实来源）：启动加载 active 行到内存缓存
 * （usage-source-labels 的 module 级缓存，labelForSource / source-options / 扣费校验共用），
 * 读时按 TTL 懒刷新。表数据由 seed 维护：`tsx prisma/seed.ts features`。
 */
@Injectable()
export class FeatureRegistryService implements OnModuleInit {
  private readonly logger = new Logger(FeatureRegistryService.name)
  private loadedAt = 0

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this._createMissingFeatures()
      // 只更正内部创作的旧展示名，保留人工配置和停用状态。
      await this.prisma.featureModule.updateMany({
        where: {
          source: "rpa-creation.generate",
          label: { in: ["影刀 RPA 创作", "影刀RPA创作"] },
        },
        data: { label: "内部创作" },
      })
      await this.refresh()
    } catch (error: unknown) {
      // 不阻断启动；后续扣费前 ensureFresh 仍会重试刷新。
      this.logger.warn(`功能模块注册表初始化失败（退化为静态兜底）: ${(error as Error).message}`)
    }
  }

  /** 为全新数据库补齐系统内置行；不更新已有行，尤其不覆盖人工维护的 active。 */
  private async _createMissingFeatures(): Promise<void> {
    const result = await this.prisma.featureModule.createMany({
      data: FEATURE_MODULE_DEFINITIONS.map(feature => ({ ...feature })),
      skipDuplicates: true,
    })
    if (result.count > 0) {
      this.logger.log(`已补齐 ${result.count} 条功能模块注册数据`)
    }
  }

  /** 全量刷新缓存（active 行，sortOrder 升序） */
  async refresh(): Promise<number> {
    const rows = await this.prisma.featureModule.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { source: true, label: true, module: true, moduleLabel: true },
    })
    setFeatureRegistryCache(rows)
    this.loadedAt = Date.now()
    return rows.length
  }

  /** 扣费前调用：缓存过期则刷新（失败沿用旧缓存，不阻断扣费链路） */
  async ensureFresh(): Promise<void> {
    if (Date.now() - this.loadedAt <= REGISTRY_TTL_MS) return
    await this.refresh().catch(e => {
      this.logger.warn(`功能模块注册表刷新失败（沿用旧缓存）: ${(e as Error).message}`)
    })
  }

  /** 同步查注册表行（缓存）；未登记/未加载返回 null */
  get(source: string): RegisteredFeature | null {
    return getRegisteredFeature(source)
  }

  /** 全部 active 行（缓存；未加载为空数组） */
  list(): RegisteredFeature[] {
    return listRegisteredFeatures()
  }
}
