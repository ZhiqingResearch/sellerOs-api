import { Injectable, Logger } from "@nestjs/common"
import { Cron, CronExpression } from "@nestjs/schedule"
import { BillingOrderStatus } from "@prisma/client"
import { StripeProvider } from "../../common/providers/stripe.provider"
import { PrismaService } from "../../prisma/prisma.service"
import { PAY_TIMEOUT_MS } from "../billing.constants"

/**
 * 订单超时任务（每 5 分钟，全渠道统一 15 分钟）：
 * - PENDING 超 15 分钟未支付 → EXPIRED（并 best-effort 取消 Stripe PaymentIntent，杜绝关单后支付成功）；
 * - 从未发起支付的 CREATED 超 15 分钟 → EXPIRED。
 * 已入账（SETTLED）不受影响；与 webhook/查单的状态推进不冲突（条件更新幂等）。
 */
@Injectable()
export class OrderExpiryTask {
  private readonly logger = new Logger(OrderExpiryTask.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeProvider
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async run() {
    const deadline = new Date(Date.now() - PAY_TIMEOUT_MS)
    // 先捞出待超时订单的 PaymentIntent（置 EXPIRED 后逐个取消）
    const expiring = await this.prisma.billingOrder.findMany({
      where: {
        paymentProvider: "STRIPE",
        status: BillingOrderStatus.PENDING,
        updatedAt: { lt: deadline },
      },
      select: { stripePaymentIntentId: true },
      take: 200,
    })
    const expired = await this.prisma.billingOrder.updateMany({
      where: {
        paymentProvider: "STRIPE",
        status: BillingOrderStatus.PENDING,
        updatedAt: { lt: deadline },
      },
      data: { status: BillingOrderStatus.EXPIRED, expiredAt: new Date() },
    })
    const createdExpired = await this.prisma.billingOrder.updateMany({
      where: { status: BillingOrderStatus.CREATED, createdAt: { lt: deadline } },
      data: { status: BillingOrderStatus.EXPIRED, expiredAt: new Date() },
    })
    if (expired.count || createdExpired.count) {
      this.logger.log(
        `order-expiry: EXPIRED pending=${expired.count} created=${createdExpired.count}`
      )
    }
    for (const r of expiring) {
      if (!r.stripePaymentIntentId) continue
      try {
        await this.stripe.client().paymentIntents.cancel(r.stripePaymentIntentId)
      } catch {
        // 已成功/已取消的忽略（支付成功的由 webhook/查单正常入账）
      }
    }
  }
}
