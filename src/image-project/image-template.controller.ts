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
import {
  CopyImageTemplateDto,
  CreateImageTemplateDto,
  CreateTemplateGroupDto,
  ImportImageTemplateDto,
  QueryImageTemplateDto,
  RenameTemplateGroupDto,
  TemplateItemDto,
  TemplateScopeQueryDto,
  UpdateImageTemplateDto,
} from "./image-template.dto"
import { ImageTemplateService } from "./image-template.service"

interface AuthedRequest {
  user: { id: number; phone: string; roleCode: string | null }
}

@ApiTags("图片创作 - 模板库")
@ApiBearerAuth()
@Controller("image-project/templates")
@UseGuards(JwtAuthGuard)
export class ImageTemplateController {
  constructor(private readonly service: ImageTemplateService) {}

  // 静态路径放在 /:id 之前，避免被参数路由吞掉

  @ApiOperation({ summary: "Tab 计数（全部/我的/系统），Tab 标头展示用" })
  @Get("tab-counts")
  tabCounts(@Request() req: AuthedRequest) {
    return this.service.tabCounts(req.user.id)
  }

  @ApiOperation({
    summary: "分组列表（distinct + count），下拉框使用",
    description: "随 tab 取值：mine 只看个人分组 / system 只看系统分组 / all 并集（默认）。",
  })
  @Get("groups")
  findGroups(@Query() query: TemplateScopeQueryDto, @Request() req: AuthedRequest) {
    return this.service.findGroups(req.user.id, query.tab ?? "all")
  }

  // ---- 个人分组管理（分组管理弹窗）。/groups/... 与 /groups/:id 均在 /:id 之前注册 ----

  @ApiOperation({
    summary: "分组管理列表（个人分组，含 0 模板的空分组 + 计数）",
    description:
      "分组管理弹窗使用；与筛选下拉框的 GET /groups 不同，这里只返回个人分组且含空分组与 id。",
  })
  @Get("groups/manage")
  listGroups(@Request() req: AuthedRequest) {
    return this.service.listGroups(req.user.id)
  }

  @ApiOperation({ summary: "新建空分组" })
  @Post("groups")
  createGroup(@Body() dto: CreateTemplateGroupDto, @Request() req: AuthedRequest) {
    return this.service.createGroup(req.user.id, dto.name)
  }

  @ApiOperation({
    summary: "重命名分组",
    description: "同步刷新组内个人模板的分组名；新名与已有分组重名返回 409。",
  })
  @Patch("groups/:id")
  renameGroup(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RenameTemplateGroupDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.renameGroup(req.user.id, id, dto.name)
  }

  @ApiOperation({
    summary: "删除分组（连带删除组内模板）",
    description: "组内个人模板一并软删除，返回删除的模板数量。",
  })
  @Delete("groups/:id")
  deleteGroup(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.deleteGroup(req.user.id, id)
  }

  @ApiOperation({
    summary: "标签列表（distinct + count），标签筛选条使用",
    description: "随 tab 取值：mine 只看个人标签 / system 只看系统标签 / all 并集（默认）。",
  })
  @Get("tags")
  findTags(@Query() query: TemplateScopeQueryDto, @Request() req: AuthedRequest) {
    return this.service.findTags(req.user.id, query.tab ?? "all")
  }

  @ApiOperation({
    summary: "模板列表（Tab：全部/我的/系统 + 分组/标签/关键字筛选）",
    description: "可见集合 = 自己的个人模板 ∪ 全部系统模板。",
  })
  @Get()
  findAll(@Query() query: QueryImageTemplateDto, @Request() req: AuthedRequest) {
    return this.service.findAll(query, req.user.id)
  }

  @ApiOperation({ summary: "模板详情（含图片条目）" })
  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.findOne(id, req.user.id)
  }

  @ApiOperation({ summary: "新建个人模板" })
  @Post()
  create(@Body() dto: CreateImageTemplateDto, @Request() req: AuthedRequest) {
    return this.service.create(dto, req.user.id)
  }

  @ApiOperation({
    summary: "导入分享码（按模板 id 数组批量克隆为我的个人模板）",
    description: "前端解析分享码得到 id 数组传入；已删除/不存在的 id 跳过，返回导入与跳过明细。",
  })
  @Post("import")
  import(@Body() dto: ImportImageTemplateDto, @Request() req: AuthedRequest) {
    return this.service.importTemplates(dto.ids, req.user.id)
  }

  @ApiOperation({
    summary: "追加一张图片条目到已有个人模板（生成图「存为模板 · 加到现有模板」）",
    description: "作为最后一张追加到模板末尾，返回追加后的完整模板。",
  })
  @Post(":id/items")
  addItem(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: TemplateItemDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.addItem(id, dto, req.user.id)
  }

  @ApiOperation({ summary: "复制到我的分组（克隆系统/个人模板为自己的个人模板）" })
  @Post(":id/copy")
  copy(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: CopyImageTemplateDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.copy(id, dto, req.user.id)
  }

  @ApiOperation({ summary: "编辑个人模板（传 items 时整组替换）" })
  @Patch(":id")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateImageTemplateDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.update(id, dto, req.user.id)
  }

  @ApiOperation({ summary: "删除个人模板（软删除）" })
  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.remove(id, req.user.id)
  }
}
