import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import { StripeProvider } from "../common/providers/stripe.provider"

/** 汇率内存缓存 TTL：10 分钟 */
const FX_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * 汇率：发起支付时把人民币应付折算成美元美分（Stripe 收款币种 USD）。
 * 数据源 = Stripe FX Quotes（preview）的 CNY→USD base_rate（市场基准，不含 FX 费；
 * 我们 USD 直接收款、Stripe 不发生兑换），取倒数得 1 USD = X CNY。
 * 内存缓存 10 分钟；拉取失败有旧缓存走 stale 兜底，从未成功抛 503。
 */
@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name)
  private cache: { rate: Decimal; at: number } | null = null

  constructor(private readonly stripe: StripeProvider) {}

  /** 取 USD→CNY 汇率（1 USD = X CNY）；缓存新鲜直接返回 */
  async getUsdCnyRate(): Promise<Decimal> {
    if (this.cache && Date.now() - this.cache.at < FX_CACHE_TTL_MS) return this.cache.rate
    try {
      const baseRate = await this.stripe.getCnyUsdBaseRate() // 1 CNY = X USD
      this.cache = { rate: new Decimal(1).div(baseRate), at: Date.now() }
      return this.cache.rate
    } catch (e) {
      if (this.cache) {
        this.logger.warn(`汇率拉取失败，沿用旧缓存（stale）：${(e as Error).message}`)
        return this.cache.rate
      }
      // 底层已是 503（如「支付服务未配置」）直接透传，不包装成汇率错误误导排查
      if (e instanceof ServiceUnavailableException) throw e
      this.logger.error(`汇率拉取失败且无缓存可用：${(e as Error).message}`)
      throw new ServiceUnavailableException("汇率服务暂不可用，请稍后重试")
    }
  }

  /** 人民币（元）→ 美元美分：round(元 × 100 ÷ 汇率)，HALF_UP；低于 Stripe 最低 $0.50 抛 400 */
  cnyToUsdCents(amountCny: Decimal, rate: Decimal): number {
    const cents = amountCny.mul(100).div(rate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
    if (cents < 50) throw new BadRequestException("折算美元金额低于支付渠道最低限额")
    return cents
  }
}
