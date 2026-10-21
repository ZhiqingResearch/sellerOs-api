import { Module } from "@nestjs/common"
import { MembershipModule } from "../membership/membership.module"
import { TeamModule } from "../team/team.module"
import { AllinpayPaymentsService } from "./allinpay-payments.service"
import { AllinpayWebhookController } from "./allinpay-webhook.controller"
import { BillingMailService } from "./billing-mail.service"
import { BillingSettleService } from "./billing-settle.service"
import { CatalogController } from "./catalog.controller"
import { CatalogService } from "./catalog.service"
import { CustomLadderService } from "./custom-ladder.service"
import { FxService } from "./fx.service"
import { OrderPricingService } from "./order-pricing.service"
import { BillingRecordsController, OrdersController } from "./orders.controller"
import { OrdersService } from "./orders.service"
import { ReceiptPdfService } from "./receipt-pdf.service"
import { ReceiptsController } from "./receipts.controller"
import { ReceiptsService } from "./receipts.service"
import { StripeWebhookController } from "./stripe-webhook.controller"
import { ExpiryReminderTask } from "./tasks/expiry-reminder.task"
import { OrderExpiryTask } from "./tasks/order-expiry.task"

// PrismaModule / ProvidersModule(StripeProvider, MailProvider) 为 @Global，无需 imports。
// MembershipModule 提供 CreditService（积分记账唯一入口）；TeamModule 提供 TeamService/TeamPoolService（团队单结算）。
@Module({
  imports: [MembershipModule, TeamModule],
  controllers: [
    AllinpayWebhookController,
    CatalogController,
    OrdersController,
    BillingRecordsController,
    ReceiptsController,
    StripeWebhookController,
  ],
  providers: [
    AllinpayPaymentsService,
    CatalogService,
    CustomLadderService,
    OrderPricingService,
    OrdersService,
    FxService,
    BillingSettleService,
    ReceiptsService,
    ReceiptPdfService,
    BillingMailService,
    OrderExpiryTask,
    ExpiryReminderTask,
  ],
  exports: [CustomLadderService, BillingSettleService],
})
export class BillingModule {}
