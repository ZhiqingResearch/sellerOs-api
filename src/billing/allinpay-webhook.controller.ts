import { Controller, Header, HttpCode, Post, Req } from "@nestjs/common"
import { ApiExcludeEndpoint, ApiTags } from "@nestjs/swagger"
import type { Request } from "express"
import { AllinpayPaymentsService } from "./allinpay-payments.service"

@ApiTags("支付回调")
@Controller("billing/webhooks")
export class AllinpayWebhookController {
  constructor(private readonly payments: AllinpayPaymentsService) {}

  @Post("allinpay")
  @HttpCode(200)
  @Header("Content-Type", "text/plain; charset=utf-8")
  @ApiExcludeEndpoint()
  handle(@Req() req: Request) {
    // 保留全部 form 字段验签（含通联将来新增字段），避免 DTO whitelist 改变签名原文。
    // 验签失败/事务失败抛异常，成功处理才返回通联要求的纯文本 success。
    return this.payments.notify(req.body as unknown)
  }
}
