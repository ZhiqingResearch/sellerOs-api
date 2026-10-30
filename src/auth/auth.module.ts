import { Global, Module } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { JwtModule } from "@nestjs/jwt"
import { PassportModule } from "@nestjs/passport"
import { MembershipModule } from "../membership/membership.module"
import { SmsModule } from "../sms/sms.module"
import { AuthController } from "./auth.controller"
import { AuthService } from "./auth.service"
import { InternalAccountGuard } from "./guards/internal-account.guard"
import { PermissionsGuard } from "./guards/permissions.guard"
import { PermissionCacheService } from "./services/permission-cache.service"
import { JwtStrategy } from "./strategies/jwt.strategy"

@Global()
@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("JWT_SECRET"),
        signOptions: { expiresIn: "7d" },
      }),
    }),
    SmsModule,
    MembershipModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    PermissionCacheService,
    PermissionsGuard,
    InternalAccountGuard,
  ],
  exports: [PermissionsGuard, PermissionCacheService, InternalAccountGuard],
})
export class AuthModule {}
