import { Module } from "@nestjs/common"
import { CompetitorEvidenceProvider } from "../competitor-analysis/competitor-evidence.provider"
import { MembershipModule } from "../membership/membership.module"
import { PricingModule } from "../pricing/pricing.module"
import { SkillsKeysModule } from "../skills-keys/skills-keys.module"
import { UsageModule } from "../usage/usage.module"
import { KeybCreditController } from "./keyb-credit.controller"
import { KeybCreditService } from "./keyb-credit.service"
import { OpenApiAuthGuard } from "./open-api-auth.guard"
import { OpenCreditController } from "./open-credit.controller"
import { OpenOperationPlanController } from "./open-operation-plan.controller"
import { OpenOperationPlanService } from "./open-operation-plan.service"
import { OpenOperationQueryController } from "./open-operation-query.controller"
import { OpenProductAnalysisController } from "./open-product-analysis.controller"
import { OpenProductAnalysisService } from "./open-product-analysis.service"

/**
 * 对外开放接口（/api/open/*）：其他项目服务间调用本平台能力（积分扣费等）。
 * 与对内 JWT 体系完全隔离——AppId + HMAC-SHA256 签名鉴权（OpenApiAuthGuard），
 * 接入方由 scripts/create-open-api-app.ts 创建（OpenApiApp 表）。
 */
@Module({
  imports: [UsageModule, MembershipModule, SkillsKeysModule, PricingModule],
  controllers: [
    OpenCreditController,
    KeybCreditController,
    OpenOperationPlanController,
    OpenOperationQueryController,
    OpenProductAnalysisController,
  ],
  providers: [
    OpenApiAuthGuard,
    KeybCreditService,
    OpenOperationPlanService,
    OpenProductAnalysisService,
    CompetitorEvidenceProvider,
  ],
})
export class OpenApiModule {}
