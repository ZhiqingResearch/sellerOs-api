import { UsageModule } from "../usage/usage.module"
import { Module } from "@nestjs/common"
import { BusinessAiModule } from "../common/business-ai/business-ai.module"
import { SmartPricingAiController } from "./smart-pricing-ai.controller"
import { SmartPricingRecordController } from "./smart-pricing-record.controller"
import { SmartPricingRecordService } from "./smart-pricing-record.service"

@Module({
  imports: [BusinessAiModule, UsageModule],
  controllers: [SmartPricingRecordController, SmartPricingAiController],
  providers: [SmartPricingRecordService],
})
export class SmartPricingModule {}
