import { Body, Controller, Get, Post, Request, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import { AuthService } from "./auth.service"
import { ChangePasswordDto } from "./dto/change-password.dto"
import { LoginDto } from "./dto/login.dto"
import { MeResponseDto, PermissionsResponseDto } from "./dto/me.dto"
import { RegisterDto } from "./dto/register.dto"
import { SendCodeDto } from "./dto/send-code.dto"
import { SmsLoginDto } from "./dto/sms-login.dto"
import { SwitchOrgDto } from "./dto/switch-org.dto"
import { JwtAuthGuard } from "./guards/jwt-auth.guard"
import { AuthenticatedUser } from "./types"

@ApiTags("认证")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  @ApiOperation({
    summary: "手机号自助注册（短信验证、可选邀请码、无需审核，直接返回 access_token）",
  })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto)
  }

  @Post("login")
  @ApiOperation({ summary: "密码登录" })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto)
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "获取当前登录用户信息（含角色与权限列表）" })
  @ApiOkResponse({ type: MeResponseDto })
  getMe(@Request() req: { user: AuthenticatedUser }) {
    return this.authService.getMe(req.user.id)
  }

  @Get("permissions")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "获取当前用户的权限列表与菜单分组（不含 user/role）" })
  @ApiOkResponse({ type: PermissionsResponseDto })
  getPermissions(@Request() req: { user: AuthenticatedUser }) {
    return this.authService.getPermissions(req.user.id)
  }

  @Post("change-password")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "修改当前用户密码（成功后清除强制改密标记）" })
  changePassword(@Request() req: { user: AuthenticatedUser }, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(req.user.id, dto.oldPassword, dto.newPassword)
  }

  @Post("switch-org")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "切换当前组织（重签 token；orgId 传 null 清空）" })
  switchOrg(@Request() req: { user: AuthenticatedUser }, @Body() dto: SwitchOrgDto) {
    return this.authService.switchOrg(req.user.id, dto.orgId ?? null)
  }

  @Post("login-sms")
  @ApiOperation({ summary: "短信验证码登录" })
  loginBySms(@Body() dto: SmsLoginDto) {
    return this.authService.loginBySms(dto)
  }

  @Post("send-code")
  @ApiOperation({ summary: "发送短信验证码" })
  sendCode(@Body() dto: SendCodeDto) {
    return this.authService.sendCode(dto.phone)
  }
}
