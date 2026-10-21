import { Module } from "@nestjs/common"
import { AuditModule } from "../audit/audit.module"
import { UsageModule } from "../usage/usage.module"
import { AsinAuditBilling } from "./asin-audit.billing"
import { AsinAuditController } from "./asin-audit.controller"
import { AsinAuditModels } from "./asin-audit.models"
import { AuditOptimizeService } from "./audit-optimize.service"
import { AuditScoreService } from "./audit-score.service"
import { AsinAuditEvidenceController } from "./evidence/evidence.controller"
import { EvidenceService } from "./evidence/evidence.service"
import { SellerSpriteMcpClient } from "./evidence/mcp.client"
import { SifClient } from "./evidence/sif.client"
import { ReviewAnalysisService } from "./review-analysis.service"
import { ReviewPainPointsService } from "./review-pain-points.service"

@Module({
  imports: [UsageModule, AuditModule],
  controllers: [AsinAuditController, AsinAuditEvidenceController],
  providers: [
    AsinAuditModels,
    AsinAuditBilling,
    ReviewPainPointsService,
    ReviewAnalysisService,
    AuditScoreService,
    AuditOptimizeService,
    SifClient,
    SellerSpriteMcpClient,
    EvidenceService,
  ],
})
export class AsinAuditModule {}
