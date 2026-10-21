import { Module } from "@nestjs/common"
import { AiGatewayModule } from "../ai-gateway/ai-gateway.module"
import { UsageModule } from "../usage/usage.module"
import { InternalLlmToolboxController } from "./internal-llm-toolbox.controller"
import { LlmToolboxBilling } from "./llm-toolbox.billing"
import { LlmToolboxController } from "./llm-toolbox.controller"
import { LlmToolboxService } from "./llm-toolbox.service"

// 三件套走 src/ai-gateway 版 AiGatewayProvider（completeMultimodal 非流式）；
// ⚠️ 与 src/common/providers 同名类是两个不同的 DI token，勿混用 import 路径（方案 R1）。
@Module({
  imports: [AiGatewayModule, UsageModule],
  controllers: [LlmToolboxController, InternalLlmToolboxController],
  providers: [LlmToolboxService, LlmToolboxBilling],
})
export class LlmToolboxModule {}
