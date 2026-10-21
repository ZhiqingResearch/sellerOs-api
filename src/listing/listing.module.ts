import { Module } from "@nestjs/common"
import { HistoryModule } from "../history/history.module"
import { UsageModule } from "../usage/usage.module"
import { ListingAiPermissionGuard } from "./guards/listing-ai-permission.guard"
import { ListingModelSelectionGuard } from "./guards/listing-model-selection.guard"
import { ListingAiService } from "./listing-ai.service"
import { ListingDocumentService } from "./listing-document.service"
import { ListingGenerationService } from "./listing-generation.service"
import { ListingRunService } from "./listing-run.service"
import { ListingScoreService } from "./listing-score.service"
import { ListingController } from "./listing.controller"

@Module({
  imports: [UsageModule, HistoryModule],
  controllers: [ListingController],
  providers: [
    ListingAiService,
    ListingScoreService,
    ListingDocumentService,
    ListingAiPermissionGuard,
    ListingModelSelectionGuard,
    ListingRunService,
    ListingGenerationService,
  ],
})
export class ListingModule {}
