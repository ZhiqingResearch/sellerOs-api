import { Module } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { JwtModule } from "@nestjs/jwt"
import { MembershipModule } from "../membership/membership.module"
import { AuthEmailController } from "./auth-email.controller"
import { AuthEmailService } from "./auth-email.service"
import { AuthSsoController } from "./auth-sso.controller"
import { AuthSsoService } from "./auth-sso.service"
import { EmailAuthCodeService } from "./email-auth-code.service"

/**
 * 邮箱认证通道（开放注册 / 邮箱登录 / 找回密码），与手机号登录的 AuthModule 完全独立。
 * 自注册同配置的 JwtModule（同 secret + 7d 过期）：签出的 token 与 /auth/login 互通，
 * JwtAuthGuard / JwtStrategy 零适配直接生效。
 * 另含跨域登录交接（auth/sso/*，海外首页 → Seller 主站的一次性 code 换 token）。
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("JWT_SECRET"),
        signOptions: { expiresIn: "7d" },
      }),
    }),
    MembershipModule, // 注册送积分（CreditService）
  ],
  controllers: [AuthEmailController, AuthSsoController],
  providers: [AuthEmailService, EmailAuthCodeService, AuthSsoService],
})
export class AuthEmailModule {}
