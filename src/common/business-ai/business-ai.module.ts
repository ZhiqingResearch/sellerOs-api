import { Module } from "@nestjs/common"
import { UsageModule } from "../../usage/usage.module"
import { BusinessAiRunController } from "./business-ai-run.controller"
import { BusinessAiService } from "./business-ai.service"

@Module({
  imports: [UsageModule],
  controllers: [BusinessAiRunController],
  providers: [BusinessAiService],
  exports: [BusinessAiService],
})
export class BusinessAiModule {}
