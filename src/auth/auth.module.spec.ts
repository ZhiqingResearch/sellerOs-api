import { Global, Module } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import { MailProvider } from "../common/providers/mail.provider"
import { DefaultMemberRoleService } from "../common/services/default-member-role.service"
import { CreditService } from "../membership/credit.service"
import { InviteService } from "../membership/invite.service"
import { PrismaService } from "../prisma/prisma.service"
import { AuthModule } from "./auth.module"
import { AuthService } from "./auth.service"

@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useValue: new ConfigService({
        JWT_SECRET: "registration-test-secret",
        ACCESS_KEY_ID: "test",
        ACCESS_KEY_SECRET: "test",
      }),
    },
    { provide: PrismaService, useValue: {} },
    { provide: MailProvider, useValue: {} },
  ],
  exports: [ConfigService, PrismaService, MailProvider],
})
class DependenciesModule {}

it("认证模块可解析注册所需的积分、默认角色和邀请服务依赖", async () => {
  const module = await Test.createTestingModule({
    imports: [DependenciesModule, AuthModule],
  }).compile()
  try {
    expect(module.get(AuthService)).toBeInstanceOf(AuthService)
    expect(module.get(CreditService)).toBeInstanceOf(CreditService)
    expect(module.get(DefaultMemberRoleService)).toBeInstanceOf(DefaultMemberRoleService)
    expect(module.get(InviteService)).toBeInstanceOf(InviteService)
  } finally {
    await module.close()
  }
})
