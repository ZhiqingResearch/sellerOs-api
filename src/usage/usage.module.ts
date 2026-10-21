import { Module } from "@nestjs/common"
import { MembershipModule } from "../membership/membership.module"
import { PricingModule } from "../pricing/pricing.module"
import { TeamModule } from "../team/team.module"
import { AuditPrismaService } from "./audit-prisma.service"
import { FeatureRegistryService } from "./feature-registry.service"
import { GenerationRecordService } from "./generation-record.service"
import { InternalCreditController } from "./internal-credit.controller"
import { UsageController } from "./usage.controller"
import { UsageService } from "./usage.service"

// TeamModule 提供 TeamQuotaService（消费路由：归属 active 企业 → 团队共享池扣费）
@Module({
  imports: [PricingModule, MembershipModule, TeamModule],
  controllers: [UsageController, InternalCreditController],
  providers: [UsageService, GenerationRecordService, AuditPrismaService, FeatureRegistryService],
  exports: [UsageService, FeatureRegistryService],
})
export class UsageModule {}
