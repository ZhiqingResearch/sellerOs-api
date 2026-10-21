import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PaginationDto } from "../common/dto/pagination.dto"
import { AnnouncementService } from "./announcement.service"
import { CreateAnnouncementDto } from "./dto/create-announcement.dto"

@ApiTags("公告管理")
@ApiBearerAuth()
@Controller("announcements")
@UseGuards(JwtAuthGuard)
export class AnnouncementController {
  constructor(private readonly announcementService: AnnouncementService) {}

  @Post()
  @ApiOperation({
    summary: "发布公告",
    description: "时间区间不得与已有未删除公告重叠（边界相接不算重叠）",
  })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateAnnouncementDto) {
    return this.announcementService.create(req.user.id, dto)
  }

  @Get()
  @ApiOperation({ summary: "查询历史公告（全部状态，按创建时间倒序分页）" })
  findAll(@Query() query: PaginationDto) {
    return this.announcementService.findAll(query)
  }

  @Get("active")
  @ApiOperation({ summary: "查询生效中公告（当前时间在 [startAt, endAt] 内，不分页返回数组）" })
  findActive() {
    return this.announcementService.findActive()
  }

  @Delete(":id")
  @ApiOperation({ summary: "软删除公告" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.announcementService.remove(id)
  }
}
