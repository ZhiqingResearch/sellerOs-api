/**
 * 本地隔离联调：真实调用 AI Gateway（产生网关费用），模拟用户/钱包，只监听回环地址。
 * node -r ts-node/register scripts/smoke-business-ai-server.ts
 * 前端设置 BUSINESS_AI_SMOKE_URL=http://127.0.0.1:8013 后运行 business-ai-live.test.ts。
 */
import { UnauthorizedException, ValidationPipe, type ExecutionContext } from "@nestjs/common"
import { HttpService } from "@nestjs/axios"
import { AliyunContentModerationProvider } from "../src/common/providers/aliyun-content-moderation.provider"
import { ContentModerationService } from "../src/content-moderation/content-moderation.service"
import { ContentSnapshotService } from "../src/content-moderation/content-snapshot.service"
import { SpacesService } from "../src/spaces/spaces.service"
import { ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import "reflect-metadata"
import { JwtAuthGuard } from "../src/auth/guards/jwt-auth.guard"
import { PermissionCacheService } from "../src/auth/services/permission-cache.service"
import { BusinessAiService } from "../src/common/business-ai/business-ai.service"
import { safeMultiplier } from "../src/common/price-multiplier.util"
import { AiGatewayProvider } from "../src/common/providers/ai-gateway.provider"
import { PrismaService } from "../src/prisma/prisma.service"
import { PromotionPlanAiController } from "../src/promotion-plan/promotion-plan-ai.controller"
import { SmartPricingAiController } from "../src/smart-pricing/smart-pricing-ai.controller"
import { UsageService } from "../src/usage/usage.service"

async function main() {
  mkdirSync(resolve("temp"), { recursive: true })
  const charges: object[] = []
  const module = await Test.createTestingModule({
    controllers: [PromotionPlanAiController, SmartPricingAiController],
    providers: [
      BusinessAiService,
      AiGatewayProvider,
      AliyunContentModerationProvider,
      ContentModerationService,
      ContentSnapshotService,
      SpacesService,
      HttpService,
      PrismaService,
      {
        provide: ConfigService,
        useValue: new ConfigService({ ...process.env, AI_GATEWAY_DEBUG_LOGGING: "false" }),
      },
      {
        provide: UsageService,
        inject: [PrismaService],
        useFactory: (prisma: PrismaService) => ({
          gatewayPriceMultiplier: async (publicId: string) => {
            const model = await prisma.aiGatewayModel.findFirst({
              where: { publicId },
              select: { priceMultiplier: true },
            })
            return safeMultiplier(model?.priceMultiplier)
          },
          chargeModel: (userId: number, cost: { toString(): string }, metadata: object) => {
            charges.push({ userId, billedCostCny: cost.toString(), metadata })
            writeFileSync(
              resolve("temp/business-ai-live-charges.json"),
              JSON.stringify(charges, null, 2)
            )
          },
        }),
      },
      {
        provide: PermissionCacheService,
        useValue: {
          getForUser: () => new Set(["tool.promotion_plan", "tool.smart_pricing"]),
          getLabelMap: () => new Map(),
        },
      },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate(context: ExecutionContext) {
        const request = context.switchToHttp().getRequest<{
          headers: { authorization?: string }
          user?: { id: number }
        }>()
        if (request.headers.authorization !== "Bearer local-business-smoke")
          throw new UnauthorizedException()
        request.user = { id: 0 }
        return true
      },
    })
    .compile()
  const app = module.createNestApplication()
  app.setGlobalPrefix("api")
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
  await app.listen(8013, "127.0.0.1")
  console.log("本地真实网关联调服务 8013；业务积分扣费仅捕获校验，不写用户钱包")
}
void main()
