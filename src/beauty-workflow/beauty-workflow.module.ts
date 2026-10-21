import { Module } from "@nestjs/common"
import { AiGatewayModule } from "../ai-gateway/ai-gateway.module"
import { UsageModule } from "../usage/usage.module"
import { BeautyWorkflowController } from "./beauty-workflow.controller"
import { BeautyWorkflowService } from "./beauty-workflow.service"

@Module({
  imports: [AiGatewayModule, UsageModule],
  controllers: [BeautyWorkflowController],
  providers: [BeautyWorkflowService],
})
export class BeautyWorkflowModule {}
