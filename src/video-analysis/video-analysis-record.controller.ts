import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PaginationDto } from "../common/dto/pagination.dto"
import { VideoAnalysisRecordService } from "./video-analysis-record.service"

const recordIdPipe = new ParseUUIDPipe({
  version: "4",
  exceptionFactory: () => new BadRequestException("视频分析记录编号必须是有效的 UUID"),
})

@ApiTags("视频分析记录")
@ApiBearerAuth()
@Controller("video-analysis/records")
@UseGuards(JwtAuthGuard)
export class VideoAnalysisRecordController {
  constructor(private readonly records: VideoAnalysisRecordService) {}

  @Get()
  @ApiOperation({ summary: "分页查询当前用户的视频分析记录摘要" })
  findAll(@Request() req: { user: { id: number } }, @Query() query: PaginationDto) {
    return this.records.findAll(req.user.id, query)
  }

  @Get(":recordId")
  @ApiOperation({ summary: "查询当前用户的视频分析完整报告" })
  findOne(
    @Request() req: { user: { id: number } },
    @Param("recordId", recordIdPipe) recordId: string
  ) {
    return this.records.findOne(req.user.id, recordId)
  }

  @Delete(":recordId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "软删除当前用户的视频分析记录（保留计费流水）" })
  remove(
    @Request() req: { user: { id: number } },
    @Param("recordId", recordIdPipe) recordId: string
  ) {
    return this.records.remove(req.user.id, recordId)
  }
}
