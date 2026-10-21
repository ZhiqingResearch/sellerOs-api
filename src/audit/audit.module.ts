import { Module } from "@nestjs/common"
import { AuditController } from "./audit.controller"
import { AuditService } from "./audit.service"
import { AsinAuditRecordController } from "./records/asin-audit-record.controller"
import { AsinAuditRecordService } from "./records/asin-audit-record.service"

@Module({
  controllers: [AuditController, AsinAuditRecordController],
  providers: [AuditService, AsinAuditRecordService],
  exports: [AuditService],
})
export class AuditModule {}
