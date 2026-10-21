import { Module } from "@nestjs/common"
import { AsinEvidenceRecordController } from "./asin-evidence-record.controller"
import { AsinEvidenceRecordService } from "./asin-evidence-record.service"

@Module({
  controllers: [AsinEvidenceRecordController],
  providers: [AsinEvidenceRecordService],
})
export class AsinEvidenceRecordModule {}
