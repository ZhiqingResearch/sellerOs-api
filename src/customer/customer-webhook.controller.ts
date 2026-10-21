import { Body, Controller, Post } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import {
  type AvatarWebhookPayload,
  type VideoWebhookPayload,
  type VoiceWebhookPayload,
} from "src/common/providers/baidu-xiling.provider"
import { CustomerService } from "./customer.service"

@ApiTags("客户 Webhook")
@Controller("customer/webhook")
export class CustomerWebhookController {
  constructor(private readonly customerService: CustomerService) {}

  @ApiOperation({ summary: "百度曦灵数字人训练回调" })
  @Post("avatar")
  handleAvatarWebhook(@Body() body: AvatarWebhookPayload) {
    return this.customerService.handleAvatarWebhook(body)
  }

  @ApiOperation({ summary: "百度曦灵声音克隆回调" })
  @Post("voice")
  handleVoiceWebhook(@Body() body: VoiceWebhookPayload) {
    return this.customerService.handleVoiceWebhook(body)
  }

  @ApiOperation({ summary: "百度曦灵视频合成回调" })
  @Post("video")
  handleVideoWebhook(@Body() body: VideoWebhookPayload) {
    return this.customerService.handleVideoWebhook(body)
  }
}
