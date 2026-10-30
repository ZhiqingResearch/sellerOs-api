import { Module } from "@nestjs/common"
import { DefaultMemberRoleService } from "../common/services/default-member-role.service"
import { AdminDistController } from "./admin-dist.controller"
import { AdminDistService } from "./admin-dist.service"
import { AdminRechargeController } from "./admin-recharge.controller"
import { AdminRechargeService } from "./admin-recharge.service"
import { AdminSubscriptionController } from "./admin-subscription.controller"
import { AdminSubscriptionService } from "./admin-subscription.service"
import { CreditExpiryTask } from "./credit-expiry.task"
import { CreditService } from "./credit.service"
import { RechargeAccountGuard } from "./guards/recharge-account.guard"
import { InviteConfigController } from "./invite-config.controller"
import { InviteController } from "./invite.controller"
import { InviteService } from "./invite.service"
import { MembershipInviteController } from "./membership-invite.controller"
import { PlanActivationTask } from "./plan-activation.task"
import { RechargeAccessService } from "./recharge-access.service"
import { RechargeFlagController } from "./recharge-flag.controller"
import { WalletController } from "./wallet.controller"
import { WalletService } from "./wallet.service"

// PrismaModule / AuthModule(PermissionsGuard) / ProvidersModule(MailProvider) 为 @Global，无需 imports。
@Module({
  controllers: [
    AdminRechargeController,
    RechargeFlagController,
    InviteController,
    MembershipInviteController,
    InviteConfigController,
    AdminDistController,
    AdminSubscriptionController,
    WalletController,
  ],
  providers: [
    DefaultMemberRoleService,
    CreditService,
    AdminRechargeService,
    RechargeAccessService,
    RechargeAccountGuard,
    InviteService,
    AdminDistService,
    AdminSubscriptionService,
    WalletService,
    CreditExpiryTask,
    PlanActivationTask,
  ],
  exports: [CreditService, WalletService, DefaultMemberRoleService, InviteService],
})
export class MembershipModule {}
