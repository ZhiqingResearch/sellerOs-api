import { Module } from "@nestjs/common"
import { SpacesModule } from "../spaces/spaces.module"
import { UsageModule } from "../usage/usage.module"
import { AiGatewayImageArtifactService } from "./ai-gateway-image-artifact.service"
import { AiGatewayImageCallbacksService } from "./ai-gateway-image-callbacks.service"
import { AiGatewayModelController } from "./ai-gateway-model.controller"
import { AiGatewayModelService } from "./ai-gateway-model.service"
import { AiGatewayWebhookController } from "./ai-gateway-webhook.controller"
import { AiGatewayWebhookService } from "./ai-gateway-webhook.service"
import { AiGatewayProvider } from "./ai-gateway.provider"
import { ChetaidouGatewayReceiptService } from "./chetaidou-gateway-receipt.service"

@Module({
  imports: [UsageModule, SpacesModule],
  controllers: [AiGatewayModelController, AiGatewayWebhookController],
  providers: [
    AiGatewayProvider,
    AiGatewayModelService,
    AiGatewayImageArtifactService,
    AiGatewayImageCallbacksService,
    AiGatewayWebhookService,
    ChetaidouGatewayReceiptService,
  ],
  exports: [
    AiGatewayProvider,
    AiGatewayModelService,
    AiGatewayWebhookService,
    AiGatewayImageCallbacksService,
    ChetaidouGatewayReceiptService,
  ],
})
export class AiGatewayModule {}
