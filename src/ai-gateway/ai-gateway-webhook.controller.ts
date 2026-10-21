import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  type RawBodyRequest,
} from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { AI_GATEWAY_WEBHOOK_HEADERS } from "@zhiqingresearch/ai-ts-sdk"
import type { Request } from "express"
import { AiGatewayWebhookService } from "./ai-gateway-webhook.service"

@ApiTags("AI Gateway")
@Controller("webhooks/ai-gateway")
export class AiGatewayWebhookController {
  constructor(private readonly service: AiGatewayWebhookService) {}

  @ApiOperation({ summary: "接收 AI Gateway 任务终态回调" })
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers(AI_GATEWAY_WEBHOOK_HEADERS.secretVersion) secretVersion?: string,
    @Headers(AI_GATEWAY_WEBHOOK_HEADERS.timestamp) timestamp?: string,
    @Headers(AI_GATEWAY_WEBHOOK_HEADERS.signature) signature?: string,
    @Headers(AI_GATEWAY_WEBHOOK_HEADERS.eventId) eventId?: string
  ): Promise<void> {
    return this.service.receiveWebhook(request.rawBody, {
      secretVersion,
      timestamp,
      signature,
      eventId,
    })
  }
}
