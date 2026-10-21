import { Body, Controller, Get, Post, Query } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { InviteRegisterDto, SendEmailCodeDto } from "./dto/invite.dto"
import { InviteService } from "./invite.service"

/** 邀请注册（公开，无需登录）。 */
@ApiTags("邀请注册")
@Controller("invite")
export class InviteController {
  constructor(private readonly inviteService: InviteService) {}

  @Get("verify")
  @ApiOperation({ summary: "校验邀请码有效性（7 天，无效/过期返 400 无效链接）" })
  verify(@Query("code") code: string) {
    return this.inviteService.verifyInviteCode(code)
  }

  @Post("send-email-code")
  @ApiOperation({ summary: "发送邮箱注册验证码（60s 限频）" })
  sendEmailCode(@Body() dto: SendEmailCodeDto) {
    return this.inviteService.sendEmailCode(dto.email)
  }

  @Post("register")
  @ApiOperation({ summary: "邀请注册：邀请码+邮箱+手机+邮箱验证码+密码 → 待邀请人审核" })
  register(@Body() dto: InviteRegisterDto) {
    return this.inviteService.register(dto)
  }
}
