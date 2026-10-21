import { Module } from "@nestjs/common"
import { AiGatewayModule } from "../ai-gateway/ai-gateway.module"
import { UsageModule } from "../usage/usage.module"
import { InternalGenerationController } from "./internal-generation.controller"
import { InternalGenerationService } from "./internal-generation.service"
import { SalesController } from "./sales/sales.controller"
import { SalesService } from "./sales/sales.service"
import { VideoProjectController } from "./video-project.controller"
import { VideoProjectService } from "./video-project.service"

@Module({
  imports: [AiGatewayModule, UsageModule],
  controllers: [VideoProjectController, SalesController, InternalGenerationController],
  providers: [VideoProjectService, SalesService, InternalGenerationService],
  exports: [VideoProjectService],
})
export class VideoProjectModule {}
