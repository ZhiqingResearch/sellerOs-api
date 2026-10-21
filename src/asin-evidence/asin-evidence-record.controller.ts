import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { AsinEvidenceRecordService } from "./asin-evidence-record.service"
import { CreateAsinEvidenceRecordDto } from "./dto/create-asin-evidence-record.dto"
import { QueryAsinEvidenceRecordDto } from "./dto/query-asin-evidence-record.dto"

@ApiTags("ASIN 取证记录")
@ApiBearerAuth()
@Controller("asin-evidence/records")
@UseGuards(JwtAuthGuard)
export class AsinEvidenceRecordController {
  constructor(private readonly service: AsinEvidenceRecordService) {}

  @Post()
  @ApiOperation({ summary: "保存当前用户的 ASIN 取证结果（幂等，重复请求返回同一条记录）" })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateAsinEvidenceRecordDto) {
    return this.service.create(req.user.id, dto)
  }

  @Get()
  @ApiOperation({ summary: "分页查询当前用户的 ASIN 取证记录（ASIN/站点/时间/商品名摘要）" })
  findAll(@Request() req: { user: { id: number } }, @Query() query: QueryAsinEvidenceRecordDto) {
    return this.service.findAll(req.user.id, query)
  }

  @Get(":recordId")
  @ApiOperation({ summary: "查询单条取证记录详情（含完整取证结果）" })
  findOne(
    @Request() req: { user: { id: number } },
    @Param("recordId", new ParseUUIDPipe({ version: "4" })) recordId: string
  ) {
    return this.service.findOne(req.user.id, recordId)
  }

  @Delete(":recordId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "软删除当前用户的 ASIN 取证记录" })
  remove(
    @Request() req: { user: { id: number } },
    @Param("recordId", new ParseUUIDPipe({ version: "4" })) recordId: string
  ) {
    return this.service.remove(req.user.id, recordId)
  }
}
