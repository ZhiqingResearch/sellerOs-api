import { DomesticBusinessModelModule } from "../common/business-ai/domestic-business-model.module"
import { Module } from "@nestjs/common"
import { UsageModule } from "../usage/usage.module"
import { CompetitorAnalysisRecordController } from "./competitor-analysis-record.controller"
import { CompetitorAnalysisRecordService } from "./competitor-analysis-record.service"
import { CompetitorAnalysisController } from "./competitor-analysis.controller"
import { CompetitorAnalysisService } from "./competitor-analysis.service"
import { CompetitorEvidenceProvider } from "./competitor-evidence.provider"

// 双实现并存（2026-09-01 合并 release）：release 侧 = 服务端分析生成（/competitor-analysis/analyze 等，
// Keepa/SIF/SellerSprite 事实数据 + AI 中转，无库表）；feat 侧 = 前端分析结果归档 CRUD
// （/competitor-analysis/records，CompetitorAnalysisRecord 落库）。路由不冲突，功能互补。
@Module({
  imports: [DomesticBusinessModelModule, UsageModule],
  controllers: [CompetitorAnalysisController, CompetitorAnalysisRecordController],
  providers: [
    CompetitorAnalysisService,
    CompetitorEvidenceProvider,
    CompetitorAnalysisRecordService,
  ],
})
export class CompetitorAnalysisModule {}
