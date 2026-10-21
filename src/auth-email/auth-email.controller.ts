import { Body, Controller, Post } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { AuthEmailService } from "./auth-email.service"
import { EmailLoginDto } from "./dto/email-login.dto"
import { ForgotPasswordDto } from "./dto/forgot-password.dto"
import { EmailRegisterDto } from "./dto/register.dto"
import { ResetPasswordDto } from "./dto/reset-password.dto"
import { SendEmailCodeDto } from "./dto/send-code.dto"

@ApiTags("认证")
@Controller("auth/email")
export class AuthEmailController {
  constructor(private readonly authEmailService: AuthEmailService) {}

  @Post("send-code")
  @ApiOperation({ summary: "发送邮箱注册验证码（60s 限频；邮箱已注册直接 400）" })
  sendCode(@Body() dto: SendEmailCodeDto) {
    return this.authEmailService.sendRegisterCode(dto.email)
  }

  @Post("register")
  @ApiOperation({ summary: "邮箱开放注册（注册即登录，直接返回 access_token）" })
  register(@Body() dto: EmailRegisterDto) {
    return this.authEmailService.register(dto)
  }

  @Post("login")
  @ApiOperation({ summary: "邮箱密码登录" })
  login(@Body() dto: EmailLoginDto) {
    return this.authEmailService.login(dto)
  }

  @Post("forgot-password")
  @ApiOperation({ summary: "忘记密码：发送重置验证码（统一响应，不暴露账号存在性）" })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authEmailService.forgotPassword(dto.email)
  }

  @Post("reset-password")
  @ApiOperation({ summary: "重置密码（仅邮箱注册账号；成功后用新密码登录）" })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authEmailService.resetPassword(dto)
  }
}
