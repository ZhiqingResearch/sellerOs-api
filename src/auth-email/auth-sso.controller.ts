import { Body, Controller, Post, Request, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { AuthenticatedUser } from "../auth/types"
import { AuthSsoService } from "./auth-sso.service"
import { ExchangeHandoffDto } from "./dto/exchange-handoff.dto"

@ApiTags("认证")
@Controller("auth/sso")
export class AuthSsoController {
  constructor(private readonly authSsoService: AuthSsoService) {}

  @Post("handoff")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "签发跨域登录交接码（60s 有效、单次使用；响应不含跳转 URL，由前端自行拼接 #code=）",
  })
  handoff(@Request() req: { user: AuthenticatedUser }) {
    return this.authSsoService.handoff(req.user.id)
  }

  @Post("exchange")
  @ApiOperation({ summary: "核销交接码换取 access_token（公开接口；失败统一 400）" })
  exchange(@Body() dto: ExchangeHandoffDto) {
    return this.authSsoService.exchange(dto.handoffCode)
  }
}
