import { Injectable, Logger, NotFoundException } from "@nestjs/common"
import { PricingConfig, PricingTier } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { UpdatePricingDto } from "./dto/update-pricing.dto"

const CACHE_TTL_MS = Number(process.env.PRICING_CACHE_TTL_MS ?? 5 * 60 * 1000)
const TOKEN_TIER_THRESHOLD = 200000

export interface TokenPriceTier {
  tier: PricingTier
  inputPriceCny: Decimal
  outputPriceCny: Decimal
}

@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name)
  private cache: Map<string, PricingConfig> | null = null
  private cacheLoadedAt = 0
  private pendingLoad: Promise<void> | null = null

  constructor(private readonly prisma: PrismaService) {}

  /** 根据 promptTokens 判定档位，返回该档的输入+输出单价 */
  async getTokenPriceTier(promptTokens: number): Promise<TokenPriceTier> {
    const tier = promptTokens <= TOKEN_TIER_THRESHOLD ? PricingTier.LOW : PricingTier.HIGH
    const inputKey = tier === PricingTier.LOW ? "TOKEN_INPUT_LOW" : "TOKEN_INPUT_HIGH"
    const outputKey = tier === PricingTier.LOW ? "TOKEN_OUTPUT_LOW" : "TOKEN_OUTPUT_HIGH"

    const [input, output] = await Promise.all([this.getByKey(inputKey), this.getByKey(outputKey)])

    return {
      tier,
      inputPriceCny: input.markupPriceCny,
      outputPriceCny: output.markupPriceCny,
    }
  }

  /** 获取 MCP 单次调用单价（元） */
  async getMcpCallPrice(): Promise<Decimal> {
    const config = await this.getByKey("MCP_CALL")
    return config.markupPriceCny
  }

  /** 获取所有启用中的定价（预留给后台管理） */
  async listAll(): Promise<PricingConfig[]> {
    await this.ensureCacheLoaded()
    return Array.from(this.cache!.values())
  }

  /** 更新某项定价，立即失效缓存（预留给后台管理） */
  async update(key: string, dto: UpdatePricingDto): Promise<PricingConfig> {
    const exists = await this.prisma.pricingConfig.findUnique({ where: { key } })
    if (!exists) {
      throw new NotFoundException(`定价配置不存在: ${key}`)
    }

    const updated = await this.prisma.pricingConfig.update({
      where: { key },
      data: {
        name: dto.name,
        threshold: dto.threshold,
        originalPriceUsd: dto.originalPriceUsd,
        markupPriceUsd: dto.markupPriceUsd,
        markupPriceCny: dto.markupPriceCny,
        active: dto.active,
        description: dto.description,
      },
    })

    this.invalidate()
    this.logger.log(`Pricing updated: ${key}`)
    return updated
  }

  /** 手动刷新缓存（预留给后台管理） */
  refresh(): void {
    this.invalidate()
  }

  private async getByKey(key: string): Promise<PricingConfig> {
    await this.ensureCacheLoaded()
    const config = this.cache!.get(key)
    if (!config) {
      throw new NotFoundException(`定价配置不存在: ${key}`)
    }
    if (!config.active) {
      throw new NotFoundException(`定价配置已停用: ${key}`)
    }
    return config
  }

  private async ensureCacheLoaded(): Promise<void> {
    const now = Date.now()
    if (this.cache && now - this.cacheLoadedAt < CACHE_TTL_MS) {
      return
    }
    // 去重并发加载
    if (this.pendingLoad) {
      return this.pendingLoad
    }
    this.pendingLoad = (async () => {
      try {
        const configs = await this.prisma.pricingConfig.findMany()
        this.cache = new Map(configs.map(c => [c.key, c]))
        this.cacheLoadedAt = Date.now()
        this.logger.debug(`Pricing cache loaded: ${configs.length} entries`)
      } finally {
        this.pendingLoad = null
      }
    })()
    return this.pendingLoad
  }

  private invalidate(): void {
    this.cache = null
    this.cacheLoadedAt = 0
    this.pendingLoad = null
  }
}
