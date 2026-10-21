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
import type { AuthedRequest } from "./dto/common.dto"
import { ImportIdsDto } from "./dto/common.dto"
import { CopySceneDto, CreateSceneDto, QuerySceneDto, UpdateSceneDto } from "./dto/scene.dto"
import { SceneService } from "./scene.service"

@ApiTags("素材池 - 场景")
@ApiBearerAuth()
@Controller("material-pool/scenes")
@UseGuards(JwtAuthGuard)
export class SceneController {
  constructor(private readonly service: SceneService) {}

  @ApiOperation({ summary: "场景列表（分页 + 关键字）" })
  @Get()
  findAll(@Query() query: QuerySceneDto, @Request() req: AuthedRequest) {
    return this.service.findAll(query, req.user.id)
  }

  @ApiOperation({ summary: "场景标签列表（去重 + 计数，筛选 chips）" })
  @Get("tags")
  findTags(@Request() req: AuthedRequest) {
    return this.service.findTags(req.user.id)
  }

  @ApiOperation({ summary: "新建场景" })
  @Post()
  create(@Body() dto: CreateSceneDto, @Request() req: AuthedRequest) {
    return this.service.create(dto, req.user.id)
  }

  @ApiOperation({
    summary: "导入分享码（按 id 数组批量克隆）",
    description: "前端解析分享码得到 id 数组传入；已删除/不存在的跳过。",
  })
  @Post("import")
  import(@Body() dto: ImportIdsDto, @Request() req: AuthedRequest) {
    return this.service.import(dto.ids, req.user.id)
  }

  @ApiOperation({ summary: "场景详情（含 desc，供视频侧拼进可见 prompt）" })
  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.findOne(id, req.user.id)
  }

  @ApiOperation({ summary: "复制为新副本" })
  @Post(":id/copy")
  copy(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: CopySceneDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.copy(id, dto, req.user.id)
  }

  @ApiOperation({ summary: "编辑场景（传数组字段时整组替换）" })
  @Patch(":id")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateSceneDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.update(id, dto, req.user.id)
  }

  @ApiOperation({ summary: "删除场景（软删除）" })
  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.remove(id, req.user.id)
  }
}
