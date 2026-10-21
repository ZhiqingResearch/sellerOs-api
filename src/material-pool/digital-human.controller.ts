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
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { DigitalHumanService } from "./digital-human.service"
import type { AuthedRequest } from "./dto/common.dto"
import { ImportIdsDto } from "./dto/common.dto"
import {
  BatchCreateDigitalHumanDto,
  CopyDigitalHumanDto,
  CreateDigitalHumanDto,
  QueryDigitalHumanDto,
  UpdateDigitalHumanDto,
} from "./dto/digital-human.dto"

@ApiTags("素材池 - 数字人")
@ApiBearerAuth()
@Controller("material-pool/digital-humans")
@UseGuards(JwtAuthGuard)
export class DigitalHumanController {
  constructor(private readonly service: DigitalHumanService) {}

  @ApiOperation({ summary: "数字人列表（分页 + 关键字；不含 persona）" })
  @Get()
  findAll(@Query() query: QueryDigitalHumanDto, @Request() req: AuthedRequest) {
    return this.service.findAll(query, req.user.id)
  }

  @ApiOperation({ summary: "数字人标签列表（去重 + 计数，筛选 chips）" })
  @Get("tags")
  findTags(@Request() req: AuthedRequest) {
    return this.service.findTags(req.user.id)
  }

  @ApiOperation({ summary: "新建数字人" })
  @Post()
  create(@Body() dto: CreateDigitalHumanDto, @Request() req: AuthedRequest) {
    return this.service.create(dto, req.user.id)
  }

  @ApiOperation({
    summary: "批量新建（AI 角色卡入库）",
    description: "一次事务落 N 个，要么全成要么全败；body.cards 为数字人数组。",
  })
  @Post("batch")
  batchCreate(@Body() dto: BatchCreateDigitalHumanDto, @Request() req: AuthedRequest) {
    return this.service.batchCreate(dto.cards, req.user.id)
  }

  @ApiOperation({
    summary: "导入分享码（按 id 数组批量克隆）",
    description: "前端解析分享码得到 id 数组传入；已删除/不存在的跳过。",
  })
  @Post("import")
  import(@Body() dto: ImportIdsDto, @Request() req: AuthedRequest) {
    return this.service.import(dto.ids, req.user.id)
  }

  @ApiOperation({ summary: "数字人详情（含 persona，供视频侧注入隐藏人设）" })
  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.findOne(id, req.user.id)
  }

  @ApiOperation({ summary: "复制为新副本" })
  @Post(":id/copy")
  copy(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: CopyDigitalHumanDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.copy(id, dto, req.user.id)
  }

  @ApiOperation({ summary: "编辑数字人（传数组字段时整组替换）" })
  @Patch(":id")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateDigitalHumanDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.update(id, dto, req.user.id)
  }

  @ApiOperation({ summary: "删除数字人（软删除）" })
  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.remove(id, req.user.id)
  }
}
