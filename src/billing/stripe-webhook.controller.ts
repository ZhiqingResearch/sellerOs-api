import type { RawBodyRequest } from "@nestjs/common"
import { BadRequestException, Controller, Headers, HttpCode, Post, Req } from "@nestjs/common"
import { ApiExcludeEndpoint, ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import Stripe from "stripe"
import { StripeProvider } from "../common/providers/stripe.provider"
import { BillingSettleService } from "./billing-settle.service"

/**
 * Stripe webhook：验签（免 JWT）→ 事件分发。
 * 验签为唯一入账依据；处理失败返回非 2xx 由 Stripe 重试，结算本身幂等。
 * 本地联调：`stripe listen --forward-to localhost:8000/api/billing/webhooks/stripe`。
 */
@ApiTags("支付回调")
@Controller("billing/webhooks")
export class StripeWebhookController {
  constructor(
    private readonly stripe: StripeProvider,
    private readonly settle: BillingSettleService
  ) {}

  @Post("stripe")
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers("stripe-signature") signature: string
  ) {
    if (!req.rawBody) throw new BadRequestException("缺少原始请求体")
    let event: Stripe.Event
    try {
      event = this.stripe.constructEvent(req.rawBody, signature)
    } catch (e) {
      throw new BadRequestException(`webhook 验签失败: ${(e as Error).message}`)
    }

    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object
        await this.settle.settleByPaymentIntent(
          {
            id: pi.id,
            amount: pi.amount,
            currency: pi.currency,
            orderNo: pi.metadata?.orderNo ?? null,
          },
          "webhook"
        )
        break
      }
      case "payment_intent.canceled": {
        // 用户放弃/Stripe 取消：有订单则置 CANCELLED（已入账的除外）
        const pi = event.data.object
        await this.settle.cancelByPaymentIntent(pi.id)
        break
      }
      case "charge.dispute.created": {
        const dispute = event.data.object
        const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id
        const paymentIntentId =
          typeof dispute.payment_intent === "string"
            ? dispute.payment_intent
            : (dispute.payment_intent?.id ?? null)
        await this.settle.handleDisputeCreated({
          id: chargeId,
          paymentIntentId,
          amount: dispute.amount,
        })
        break
      }
      default:
        // 其余事件不处理（ACK 防 Stripe 重试轰炸）
        break
    }
    return { received: true }
  }
}
