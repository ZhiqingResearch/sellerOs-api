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
import type { AuthedRequest } from "./dto/common.dto"
import { BatchIdsDto, ImportIdsDto } from "./dto/common.dto"
import {
  BatchMoveToGroupDto,
  PersistVariantsDto,
  QueryPoolImageDto,
  StorePoolImageDto,
} from "./dto/pool-image.dto"
import { PoolImageService } from "./pool-image.service"

@ApiTags("素材池 - 素材图")
@ApiBearerAuth()
@Controller("material-pool/images")
@UseGuards(JwtAuthGuard)
export class PoolImageController {
  constructor(private readonly service: PoolImageService) {}

  // 静态路径放在 /:id 之前，避免被参数路由吞掉

  @ApiOperation({ summary: "分类聚合（distinct + count），筛选 chips 使用" })
  @Get("categories")
  findCategories(@Request() req: AuthedRequest) {
    return this.service.findCategories(req.user.id)
  }

  @ApiOperation({
    summary: "素材图列表（分页 + 关键字 + 分组/标签/分类筛选）",
    description: "卡片只展示图片；keyword 匹配 名称/prompt/标签。ungrouped=true 只看未归组。",
  })
  @Get()
  findAll(@Query() query: QueryPoolImageDto, @Request() req: AuthedRequest) {
    return this.service.findAll(query, req.user.id)
  }

  @ApiOperation({
    summary: "手动存入素材池",
    description: "按 url 去重（同名不同图可入池），已存在返回 409「已在素材池中」；可选归组。",
  })
  @Post()
  store(@Body() dto: StorePoolImageDto, @Request() req: AuthedRequest) {
    return this.service.store(dto, req.user.id)
  }

  @ApiOperation({
    summary: "变体持久化（前端拿到 N 张变体后落库，自动入池）",
    description: "不归组、打「变体」标签、不去重；传 sourceImageId 建立血缘。",
  })
  @Post("variants")
  persistVariants(@Body() dto: PersistVariantsDto, @Request() req: AuthedRequest) {
    return this.service.persistVariants(dto, req.user.id)
  }

  @ApiOperation({
    summary: "导入分享码（按素材 id 数组批量克隆为我的素材）",
    description: "前端解析分享码得到 id 数组传入；已删除/不存在的跳过，返回导入与跳过明细。",
  })
  @Post("import")
  import(@Body() dto: ImportIdsDto, @Request() req: AuthedRequest) {
    return this.service.import(dto.ids, req.user.id)
  }

  @ApiOperation({ summary: "批量移到分组（不传 groupId = 移出分组）" })
  @Post("batch/move-to-group")
  batchMoveToGroup(@Body() dto: BatchMoveToGroupDto, @Request() req: AuthedRequest) {
    return this.service.batchMoveToGroup(dto, req.user.id)
  }

  @ApiOperation({
    summary: "批量下载（返回 URL 列表，前端自行下载）",
    description: "无服务端打包；返回本人素材的 { id, name, url } 列表。",
  })
  @Post("batch/download")
  batchDownload(@Body() dto: BatchIdsDto, @Request() req: AuthedRequest) {
    return this.service.batchDownload(dto.ids, req.user.id)
  }

  @ApiOperation({ summary: "批量删除（软删除）" })
  @Post("batch/delete")
  batchRemove(@Body() dto: BatchIdsDto, @Request() req: AuthedRequest) {
    return this.service.batchRemove(dto.ids, req.user.id)
  }

  @ApiOperation({ summary: "删除单条素材（软删除）" })
  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.remove(id, req.user.id)
  }
}
