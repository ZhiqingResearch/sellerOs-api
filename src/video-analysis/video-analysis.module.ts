import { Module } from "@nestjs/common"
import { MembershipModule } from "../membership/membership.module"
import { UsageModule } from "../usage/usage.module"
import { VideoAnalysisRecordController } from "./video-analysis-record.controller"
import { VideoAnalysisRecordService } from "./video-analysis-record.service"
import { VideoAnalysisController } from "./video-analysis.controller"
import { VideoAnalysisModels } from "./video-analysis.models"
import { VideoAnalysisService } from "./video-analysis.service"

// 视频分析走 common 版 AiGatewayProvider（@Global 的 ProvidersModule，流式 streamChat）；
// ⚠️ 与 src/ai-gateway 同名类是两个不同的 DI token，勿混用 import 路径（方案 R1）。
// PrismaService 由全局 PrismaModule 提供（VideoAnalysisModels 读 AiGatewayModel 目录行）。
@Module({
  imports: [UsageModule, MembershipModule],
  controllers: [VideoAnalysisController, VideoAnalysisRecordController],
  providers: [VideoAnalysisModels, VideoAnalysisService, VideoAnalysisRecordService],
})
export class VideoAnalysisModule {}
