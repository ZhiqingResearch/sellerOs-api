import { Module } from "@nestjs/common"
import { ToolboxRecordController } from "./toolbox-record.controller"
import { ToolboxRecordService } from "./toolbox-record.service"

@Module({
  controllers: [ToolboxRecordController],
  providers: [ToolboxRecordService],
})
export class ToolboxModule {}
