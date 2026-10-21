import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import Stripe from "stripe"

/** FX Quotes 预览 API 版本头（/v1/fx_quotes 仅 preview 可用，2026-08 实测有效） */
const FX_PREVIEW_VERSION = "2025-11-17.preview"

/**
 * Stripe SDK 封装（充值计费唯一收款通道，USD 收款，美国主体）。
 * 三渠道：微信(wechat_pay PaymentIntent 内嵌 QR) / 支付宝(alipay 跳转收银台) / 银行卡(card Elements 即时确认)。
 * 未配置 STRIPE_SECRET_KEY 时不抛错只告警，支付调用时才抛 503（不阻断无支付配置的环境启动）。
 * 环境变量：
 *   STRIPE_SECRET_KEY      sk_test_... / sk_live_...
 *   STRIPE_WEBHOOK_SECRET  webhook 验签密钥（本地用 `stripe listen` 转发时的 whsec_...）
 */
@Injectable()
export class StripeProvider {
  private readonly logger = new Logger(StripeProvider.name)
  private readonly stripe: Stripe | null
  private readonly secretKey: string | null
  private readonly webhookSecret: string | null

  constructor(config: ConfigService) {
    const secretKey = config.get<string>("STRIPE_SECRET_KEY")
    this.secretKey = secretKey ?? null
    this.webhookSecret = config.get<string>("STRIPE_WEBHOOK_SECRET") || null
    if (secretKey) {
      this.stripe = new Stripe(secretKey)
    } else {
      this.stripe = null
      this.logger.warn("Stripe 未配置（STRIPE_SECRET_KEY），在线支付不可用")
    }
  }

  /** 取 SDK 客户端；未配置抛 503 */
  client(): Stripe {
    if (!this.stripe) throw new ServiceUnavailableException("支付服务未配置")
    return this.stripe
  }

  /**
   * CNY→USD 实时汇率（FX Quotes preview）：返回 base_rate（1 CNY = X USD，市场基准，不含 1% FX 费）。
   * 我们用 USD 直接收款、Stripe 侧不发生货币兑换（不扣 FX 费），故取 base_rate 而非含费的 exchange_rate。
   * SDK 稳定版未收录 fxQuotes，走原生 fetch；未配置 key 抛 503，其余失败抛 Error（由调用方缓存兜底）。
   */
  async getCnyUsdBaseRate(): Promise<number> {
    if (!this.secretKey) throw new ServiceUnavailableException("支付服务未配置")
    const res = await fetch("https://api.stripe.com/v1/fx_quotes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Stripe-Version": FX_PREVIEW_VERSION,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "to_currency=usd&from_currencies[]=cny&lock_duration=none",
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      throw new Error(`Stripe FX Quotes ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const json = (await res.json()) as {
      rates?: { cny?: { rate_details?: { base_rate?: number } } }
    }
    const rate = json.rates?.cny?.rate_details?.base_rate
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error("Stripe FX Quotes 响应缺少有效 CNY base_rate")
    }
    return rate
  }

  /** webhook 验签 + 反序列化事件；未配置验签密钥抛 503，签名不符抛 StripeSignatureVerificationError */
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    if (!this.webhookSecret) throw new ServiceUnavailableException("支付 webhook 验签未配置")
    return this.client().webhooks.constructEvent(rawBody, signature, this.webhookSecret)
  }
}
