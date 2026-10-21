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
import { CreateSmartPricingRecordDto } from "./dto/create-smart-pricing-record.dto"
import { QuerySmartPricingRecordDto } from "./dto/query-smart-pricing-record.dto"
import { SmartPricingRecordService } from "./smart-pricing-record.service"

@ApiTags("智能定价记录")
@ApiBearerAuth()
@Controller("smart-pricing/records")
@UseGuards(JwtAuthGuard)
export class SmartPricingRecordController {
  constructor(private readonly service: SmartPricingRecordService) {}

  @Post()
  @ApiOperation({ summary: "归档当前用户的完整智能定价报告" })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateSmartPricingRecordDto) {
    return this.service.create(req.user.id, dto)
  }

  @Get()
  @ApiOperation({ summary: "分页查询当前用户的智能定价记录" })
  findAll(@Request() req: { user: { id: number } }, @Query() query: QuerySmartPricingRecordDto) {
    return this.service.findAll(req.user.id, query)
  }

  @Get(":recordId")
  @ApiOperation({ summary: "查询完整智能定价快照" })
  findOne(
    @Request() req: { user: { id: number } },
    @Param("recordId", new ParseUUIDPipe({ version: "4" })) recordId: string
  ) {
    return this.service.findOne(req.user.id, recordId)
  }

  @Delete(":recordId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "软删除当前用户的智能定价记录" })
  remove(
    @Request() req: { user: { id: number } },
    @Param("recordId", new ParseUUIDPipe({ version: "4" })) recordId: string
  ) {
    return this.service.remove(req.user.id, recordId)
  }
}
