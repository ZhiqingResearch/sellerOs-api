import { Module } from "@nestjs/common"
import { UsageModule } from "../usage/usage.module"
import { CategoryAnalysisController } from "./category-analysis.controller"
import { CategoryAnalysisService } from "./category-analysis.service"
import { CategoryEvidenceProvider } from "./category-evidence.provider"

@Module({
  imports: [UsageModule],
  controllers: [CategoryAnalysisController],
  providers: [CategoryAnalysisService, CategoryEvidenceProvider],
})
export class CategoryAnalysisModule {}
