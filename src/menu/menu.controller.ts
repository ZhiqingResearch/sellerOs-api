import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import { InternalAccountGuard } from "../auth/guards/internal-account.guard"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { CreateMenuDto } from "./dto/create-menu.dto"
import { CreateMenuGroupDto } from "./dto/create-menu-group.dto"
import { MenuGroupDto, MenuNodeDto, MenuTreeResponseDto } from "./dto/menu-response.dto"
import { ReorderMenuDto } from "./dto/reorder-menu.dto"
import { UpdateMenuDto } from "./dto/update-menu.dto"
import { UpdateMenuGroupDto } from "./dto/update-menu-group.dto"
import { MenuGroupService } from "./menu-group.service"
import { MenuService } from "./menu.service"

@ApiTags("菜单管理")
@ApiBearerAuth()
@Controller("menus")
@UseGuards(JwtAuthGuard, InternalAccountGuard) // 仅内部账号（手机号），超管也挡
export class MenuController {
  constructor(
    private readonly menuService: MenuService,
    private readonly menuGroupService: MenuGroupService
  ) {}

  @Get()
  @ApiOperation({ summary: "分组菜单树（分组按 sortOrder 排序，组内菜单按 sortOrder 排序）" })
  @ApiOkResponse({ type: MenuTreeResponseDto })
  tree() {
    return this.menuService.getTree()
  }

  @Post()
  @ApiOperation({ summary: "新增菜单 / 子菜单" })
  @ApiOkResponse({ type: MenuNodeDto })
  create(@Body() dto: CreateMenuDto) {
    return this.menuService.createMenu(dto)
  }

  @Patch(":id")
  @ApiOperation({ summary: "编辑菜单" })
  @ApiOkResponse({ type: MenuNodeDto })
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateMenuDto) {
    return this.menuService.updateMenu(id, dto)
  }

  @Delete(":id")
  @ApiOperation({ summary: "删除菜单（物理删除；有子菜单则拒绝）" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.menuService.deleteMenu(id)
  }

  @Post("reorder")
  @HttpCode(200)
  @ApiOperation({ summary: "同级批量重排（传同级分组的新顺序 id 列表）" })
  reorder(@Body() dto: ReorderMenuDto) {
    return this.menuService.reorderMenus(dto)
  }

  // ── 分组管理 ──────────────────────────────────────────────

  @Get("groups")
  @ApiOperation({ summary: "分组列表（按 sortOrder 排序，含组内菜单数量）" })
  @ApiOkResponse({ type: MenuGroupDto, isArray: true })
  listGroups() {
    return this.menuGroupService.list()
  }

  @Post("groups")
  @ApiOperation({ summary: "新增分组（code 全局唯一，创建后不可修改）" })
  @ApiOkResponse({ type: MenuGroupDto })
  createGroup(@Body() dto: CreateMenuGroupDto) {
    return this.menuGroupService.create(dto)
  }

  @Patch("groups/:id")
  @ApiOperation({ summary: "编辑分组（仅分组名 / 排序；code 不可修改）" })
  @ApiOkResponse({ type: MenuGroupDto })
  updateGroup(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateMenuGroupDto) {
    return this.menuGroupService.update(id, dto)
  }

  @Delete("groups/:id")
  @ApiOperation({ summary: "删除分组（内置组不可删；组内还有菜单则拒绝）" })
  removeGroup(@Param("id", ParseIntPipe) id: number) {
    return this.menuGroupService.remove(id)
  }
}
