import { UsageModule } from "../usage/usage.module"
import { Module } from "@nestjs/common"
import { AnalysisRecordController } from "./analysis-record.controller"
import { AnalysisRecordService } from "./analysis-record.service"

@Module({
  imports: [UsageModule],
  controllers: [AnalysisRecordController],
  providers: [AnalysisRecordService],
})
export class ProductSelectionModule {}
