import { Body, Controller, Post, Request, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { BatchDeleteRecordsDto } from "./dto/batch-delete-records.dto"
import { ToolboxRecordService } from "./toolbox-record.service"

@ApiTags("工具箱记录")
@ApiBearerAuth()
@Controller("toolbox")
@UseGuards(JwtAuthGuard)
export class ToolboxRecordController {
  constructor(private readonly service: ToolboxRecordService) {}

  @Post("records/batch-delete")
  @ApiOperation({
    summary:
      "批量删除当前用户的工具箱生成记录（Listing 生成/打分、ASIN 取证/审计、竞品分析、选品、智能定价、广告优化、新品推广）",
  })
  batchDelete(@Request() req: { user: { id: number } }, @Body() dto: BatchDeleteRecordsDto) {
    return this.service.batchDelete(req.user.id, dto)
  }
}
