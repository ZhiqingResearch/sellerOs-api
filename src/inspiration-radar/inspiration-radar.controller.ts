import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { CreateSubscriptionDto } from "./dto/create-subscription.dto"
import { RefreshDto } from "./dto/refresh.dto"
import { UpdateSubscriptionDto } from "./dto/update-subscription.dto"
import { InspirationRadarService } from "./inspiration-radar.service"

interface AuthedRequest {
  user: { id: number }
}

@ApiTags("灵感雷达")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("inspiration-radar")
export class InspirationRadarController {
  constructor(private readonly service: InspirationRadarService) {}

  // ==================== 订阅 CRUD ====================

  @Post()
  @ApiOperation({ summary: "新建订阅（上限 5 个）" })
  create(@Body() dto: CreateSubscriptionDto, @Request() req: AuthedRequest) {
    return this.service.create(dto, req.user.id)
  }

  @Get()
  @ApiOperation({ summary: "获取我的订阅列表" })
  findAll(@Request() req: AuthedRequest) {
    return this.service.findAll(req.user.id)
  }

  @Patch(":id")
  @ApiOperation({ summary: "编辑订阅" })
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateSubscriptionDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.update(id, dto, req.user.id)
  }

  @Delete(":id")
  @ApiOperation({ summary: "删除订阅" })
  remove(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.remove(id, req.user.id)
  }

  // ==================== 刷新 ====================

  @Post("refresh")
  @ApiOperation({ summary: "刷新订阅（传 id 刷新单个，不传刷新全部）" })
  refresh(@Body() dto: RefreshDto, @Request() req: AuthedRequest) {
    if (dto.id) {
      return this.service.refresh(dto.id, req.user.id)
    }
    return this.service.refreshAll(req.user.id)
  }

  // ==================== 结果 ====================

  @Get(":id/items")
  @ApiOperation({ summary: "获取订阅的灵感结果" })
  @ApiQuery({ name: "mediaType", required: false, enum: ["image", "video"] })
  findItems(
    @Param("id", ParseIntPipe) id: number,
    @Query("mediaType") mediaType: string | undefined,
    @Request() req: AuthedRequest
  ) {
    return this.service.findItems(id, req.user.id, mediaType)
  }
}
