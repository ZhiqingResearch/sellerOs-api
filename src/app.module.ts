import { HttpModule } from "@nestjs/axios"
import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { ScheduleModule } from "@nestjs/schedule"
import { WinstonModule } from "nest-winston"
import { AiGatewayModule } from "./ai-gateway/ai-gateway.module"
import { AuthEmailModule } from "./auth-email/auth-email.module"
import { AnnouncementModule } from "./announcement/announcement.module"
import { AuthModule } from "./auth/auth.module"
import { BeautyWorkflowModule } from "./beauty-workflow/beauty-workflow.module"
import { CategoryAnalysisModule } from "./category-analysis/category-analysis.module"
import { ChetaidouModule } from "./chetaidou/chetaidou.module"
import { winstonAsyncConfig } from "./common/logger/winston.config"
import { LoggerMiddleware } from "./common/middleware/logger.middleware"
import { CompetitorAnalysisModule } from "./competitor-analysis/competitor-analysis.module"
import { validateEnvironment } from "./config/env.validation"
import { HistoryModule } from "./history/history.module"
import { ImageGenerationModule } from "./image-generation/image-generation.module"
import { PrismaModule } from "./prisma/prisma.module"
import { ProductReportModule } from "./product-report/product-report.module"
import { SelectedProductModule } from "./selected-product/selected-product.module"

import { AdCleaningModule } from "./ad-cleaning/ad-cleaning.module"
import { AsinAuditModule } from "./asin-audit/asin-audit.module"
import { AsinEvidenceRecordModule } from "./asin-evidence/asin-evidence-record.module"
import { AuditModule } from "./audit/audit.module"
import { BillingModule } from "./billing/billing.module"
import { ProvidersModule } from "./common/providers/providers.module"
import { CustomerModule } from "./customer/customer.module"
import { ExternalApiModule } from "./external-api/external-api.module"
import { ImageProjectModule } from "./image-project/image-project.module"
import { InspirationRadarModule } from "./inspiration-radar/inspiration-radar.module"
import { ListingModule } from "./listing/listing.module"
import { LlmToolboxModule } from "./llm-toolbox/llm-toolbox.module"
import { MaterialPoolModule } from "./material-pool/material-pool.module"
import { MembershipModule } from "./membership/membership.module"
import { MenuModule } from "./menu/menu.module"
import { OpenApiModule } from "./open-api/open-api.module"
import { OrgsModule } from "./orgs/orgs.module"
import { OssModule } from "./oss/oss.module"
import { PricingModule } from "./pricing/pricing.module"
import { ProductFactoryModule } from "./product-factory/product-factory.module"
import { ProductLibraryModule } from "./product-library/product-library.module"
import { ProductPublishModule } from "./product-publish/product-publish.module"
import { ProductSelectionModule } from "./product-selection/product-selection.module"
import { ProductModule } from "./product/product.module"
import { PromotionPlanModule } from "./promotion-plan/promotion-plan-record.module"
import { RoleModule } from "./role/role.module"
import { RpaCreationModule } from "./rpa-creation/rpa-creation.module"
import { SensitiveWordModule } from "./sensitive-word/sensitive-word.module"
import { SkillMarketModule } from "./skill-market/skill-market.module"
import { SkillsKeysModule } from "./skills-keys/skills-keys.module"
import { SmartPricingModule } from "./smart-pricing/smart-pricing.module"
import { SpacesModule } from "./spaces/spaces.module"
import { TeamModule } from "./team/team.module"
import { ToolboxModule } from "./toolbox/toolbox.module"
import { UsageModule } from "./usage/usage.module"
import { UserModule } from "./user/user.module"
import { VideoAnalysisModule } from "./video-analysis/video-analysis.module"
import { VideoProjectModule } from "./video-project/video-project.module"
import { WorkbenchModule } from "./workbench/workbench.module"

@Module({
  imports: [
    CategoryAnalysisModule,
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    ScheduleModule.forRoot(),
    WinstonModule.forRootAsync(winstonAsyncConfig),
    HttpModule.register({ global: true }),
    ProvidersModule,
    PrismaModule,
    AiGatewayModule,
    AnnouncementModule,
    ChetaidouModule,
    AuthModule,
    AuthEmailModule,
    BeautyWorkflowModule,
    HistoryModule,
    ProductReportModule,
    SelectedProductModule,
    CustomerModule,
    ExternalApiModule,
    PricingModule,
    UsageModule,
    OssModule,
    SpacesModule,
    ProductModule,
    ProductSelectionModule,
    ProductLibraryModule,
    AuditModule,
    AsinAuditModule,
    AsinEvidenceRecordModule,
    ImageProjectModule,
    ImageGenerationModule,
    ProductFactoryModule,
    ProductPublishModule,
    PromotionPlanModule,
    MaterialPoolModule,
    ListingModule,
    SensitiveWordModule,
    VideoProjectModule,
    RoleModule,
    UserModule,
    OrgsModule,
    MenuModule,
    MembershipModule,
    BillingModule,
    TeamModule,
    OpenApiModule,
    InspirationRadarModule,
    RpaCreationModule,
    AdCleaningModule,
    SmartPricingModule,
    CompetitorAnalysisModule,
    SkillMarketModule,
    SkillsKeysModule,
    ToolboxModule,
    WorkbenchModule,
    LlmToolboxModule,
    VideoAnalysisModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes("*")
  }
}
