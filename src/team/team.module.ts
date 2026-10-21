import { Module } from "@nestjs/common"
import { MembershipModule } from "../membership/membership.module"
import { TeamLifecycleTask } from "./tasks/team-lifecycle.task"
import { TeamAdminController } from "./team-admin.controller"
import { TeamConsoleController } from "./team-console.controller"
import { TeamModelConfigService } from "./team-model-config.service"
import { TeamPoolService } from "./team-pool.service"
import { TeamQuotaService } from "./team-quota.service"
import { TeamUsageService } from "./team-usage.service"
import { TeamService } from "./team.service"

// PrismaModule / ProvidersModule(MailProvider) / AuthModule 为 @Global，无需 imports。
// MembershipModule 提供 CreditService（积分记账唯一入口）。
// exports：TeamService.restoreTeam / TeamPoolService.grantPool 供 M2b 订单结算接线；
// TeamQuotaService.deductWithQuota / TeamModelConfigService.resolveModuleModels 供消费路由接线。
@Module({
  imports: [MembershipModule],
  controllers: [TeamConsoleController, TeamAdminController],
  providers: [
    TeamService,
    TeamPoolService,
    TeamQuotaService,
    TeamModelConfigService,
    TeamUsageService,
    TeamLifecycleTask,
  ],
  exports: [TeamService, TeamPoolService, TeamQuotaService, TeamModelConfigService],
})
export class TeamModule {}
