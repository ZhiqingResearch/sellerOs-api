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
import { CreatePromotionPlanRecordDto } from "./dto/create-promotion-plan-record.dto"
import { ListPromotionPlanRecordsDto } from "./dto/list-promotion-plan-records.dto"
import { PromotionPlanRecordService } from "./promotion-plan-record.service"

@ApiTags("新品推广计划记录")
@ApiBearerAuth()
@Controller("promotion-plan/records")
@UseGuards(JwtAuthGuard)
export class PromotionPlanRecordController {
  constructor(private readonly service: PromotionPlanRecordService) {}

  @Post()
  @ApiOperation({ summary: "归档一次新品推广计划生成结果（幂等）" })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreatePromotionPlanRecordDto) {
    return this.service.create(req.user.id, dto)
  }

  @Get()
  @ApiOperation({ summary: "分页查询当前用户的推广计划记录" })
  findAll(@Request() req: { user: { id: number } }, @Query() query: ListPromotionPlanRecordsDto) {
    return this.service.findAll(req.user.id, query)
  }

  @Get(":recordId")
  @ApiOperation({ summary: "查询完整推广计划快照" })
  findOne(
    @Request() req: { user: { id: number } },
    @Param("recordId", new ParseUUIDPipe({ version: "4" })) recordId: string
  ) {
    return this.service.findOne(req.user.id, recordId)
  }

  @Delete(":recordId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "删除当前用户的推广计划记录" })
  remove(
    @Request() req: { user: { id: number } },
    @Param("recordId", new ParseUUIDPipe({ version: "4" })) recordId: string
  ) {
    return this.service.remove(req.user.id, recordId)
  }
}
