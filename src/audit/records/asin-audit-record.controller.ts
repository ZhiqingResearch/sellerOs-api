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
  Put,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard"
import { AsinAuditRecordService } from "./asin-audit-record.service"
import { CreateAsinAuditRecordDto } from "./dto/create-asin-audit-record.dto"
import { QueryAsinAuditRecordDto } from "./dto/query-asin-audit-record.dto"
import { UpdateAsinAuditRecordDto } from "./dto/update-asin-audit-record.dto"

@ApiTags("ASIN 审计记录")
@ApiBearerAuth()
@Controller("asin-audit/records")
@UseGuards(JwtAuthGuard)
export class AsinAuditRecordController {
  constructor(private readonly service: AsinAuditRecordService) {}

  @Post()
  @ApiOperation({ summary: "创建当前用户的 ASIN 审计记录及第一步快照" })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateAsinAuditRecordDto) {
    return this.service.create(req.user.id, dto)
  }

  @Put(":recordId")
  @ApiOperation({ summary: "为同一审计记录新增一个 AI 优化版本" })
  optimize(
    @Request() req: { user: { id: number } },
    @Param("recordId", new ParseUUIDPipe({ version: "4" })) recordId: string,
    @Body() dto: UpdateAsinAuditRecordDto
  ) {
    return this.service.optimize(req.user.id, recordId, dto)
  }

  @Get()
  @ApiOperation({ summary: "分页查询当前用户的 ASIN 审计记录" })
  findAll(@Request() req: { user: { id: number } }, @Query() query: QueryAsinAuditRecordDto) {
    return this.service.findAll(req.user.id, query)
  }

  @Get(":recordId")
  @ApiOperation({ summary: "查询第一步快照及最新 AI 优化结果" })
  findOne(
    @Request() req: { user: { id: number } },
    @Param("recordId", new ParseUUIDPipe({ version: "4" })) recordId: string
  ) {
    return this.service.findOne(req.user.id, recordId)
  }

  @Delete(":recordId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "软删除当前用户的 ASIN 审计记录" })
  remove(
    @Request() req: { user: { id: number } },
    @Param("recordId", new ParseUUIDPipe({ version: "4" })) recordId: string
  ) {
    return this.service.remove(req.user.id, recordId)
  }
}
