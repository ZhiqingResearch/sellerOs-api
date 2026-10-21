import { DomesticBusinessModelModule } from "./domestic-business-model.module"
import { Module } from "@nestjs/common"
import { UsageModule } from "../../usage/usage.module"
import { BusinessAiRunController } from "./business-ai-run.controller"
import { BusinessAiService } from "./business-ai.service"

@Module({
  imports: [DomesticBusinessModelModule, UsageModule],
  controllers: [BusinessAiRunController],
  providers: [BusinessAiService],
  exports: [BusinessAiService],
})
export class BusinessAiModule {}
