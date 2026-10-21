import { UsageModule } from "../usage/usage.module"
import { Module } from "@nestjs/common"
import { BusinessAiModule } from "../common/business-ai/business-ai.module"
import { PromotionPlanAiController } from "./promotion-plan-ai.controller"
import { PromotionPlanRecordController } from "./promotion-plan-record.controller"
import { PromotionPlanRecordService } from "./promotion-plan-record.service"

@Module({
  imports: [BusinessAiModule, UsageModule],
  controllers: [PromotionPlanRecordController, PromotionPlanAiController],
  providers: [PromotionPlanRecordService],
})
export class PromotionPlanModule {}
