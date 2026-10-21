import { Module } from "@nestjs/common"
import { AdCleaningController } from "./ad-cleaning.controller"
import { AdCleaningService } from "./ad-cleaning.service"

@Module({
  controllers: [AdCleaningController],
  providers: [AdCleaningService],
})
export class AdCleaningModule {}
