import { Body, Controller, Header, Post, Request, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger"
import { KeybDeductDto } from "./dto/keyb-deduct.dto"
import { KeybCreditService } from "./keyb-credit.service"
import type { KeybOpenRequest } from "./open-api-auth.guard"
import { OpenApiAuthGuard } from "./open-api-auth.guard"
import { OpenApiKeybSignature } from "./open-api-keyb-signature.decorator"

@ApiTags("开放接口-KeyB积分扣费")
@ApiBearerAuth()
@Controller("open/keyb/credit")
@OpenApiKeybSignature()
@UseGuards(OpenApiAuthGuard)
export class KeybCreditController {
  constructor(private readonly service: KeybCreditService) {}

  @Post("deduct")
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: "x-sign-version", required: true, example: "v2" })
  @ApiOperation({ summary: "API 服务携带 KeyB 及 v2 服务签名扣费，消费编号支持幂等重试" })
  deduct(@Request() req: KeybOpenRequest, @Body() dto: KeybDeductDto) {
    return this.service.deduct(req.openApiApp, req.openApiKeyB, dto)
  }
}
