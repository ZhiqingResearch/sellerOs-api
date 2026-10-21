import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PaginationDto } from "../common/dto/pagination.dto"
import { CreateHistoryDto } from "./dto/create-history.dto"
import { UpdateHistoryDto } from "./dto/update-history.dto"
import { HistoryService } from "./history.service"

@ApiTags("历史记录")
@ApiBearerAuth()
@Controller("history")
@UseGuards(JwtAuthGuard)
export class HistoryController {
  constructor(private readonly historyService: HistoryService) {}

  @Get()
  @ApiOperation({ summary: "获取当前用户的历史记录列表" })
  findAll(@Request() req: { user: { id: number } }, @Query() query: PaginationDto) {
    return this.historyService.findByUser(req.user.id, query)
  }

  @Get(":id")
  @ApiOperation({ summary: "查询历史记录详情" })
  findOne(@Param("id", ParseIntPipe) id: number, @Request() req: { user: { id: number } }) {
    return this.historyService.findById(id, req.user.id)
  }

  @Post()
  @ApiOperation({ summary: "创建历史记录" })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateHistoryDto) {
    return this.historyService.create(req.user.id, dto)
  }

  @Patch(":id")
  @ApiOperation({ summary: "编辑历史记录（title/score/data，仅 data 变化时留档）" })
  update(
    @Param("id", ParseIntPipe) id: number,
    @Request() req: { user: { id: number } },
    @Body() dto: UpdateHistoryDto
  ) {
    return this.historyService.update(id, req.user.id, dto)
  }
}
