import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { MePermissionDto } from "../auth/dto/me.dto"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { CreateRoleDto } from "./dto/create-role.dto"
import { RoleItemDto, RoleUserItemDto } from "./dto/role-response.dto"
import { UpdateRoleDto } from "./dto/update-role.dto"
import { RoleService } from "./role.service"

@ApiTags("角色管理")
@ApiBearerAuth()
@Controller("roles")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("management.roles")
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Get()
  @ApiOperation({ summary: "角色列表（含用户数与权限 key）" })
  @ApiOkResponse({ type: RoleItemDto, isArray: true })
  list() {
    return this.roleService.listRoles()
  }

  @Post()
  @ApiOperation({ summary: "新建角色" })
  @ApiOkResponse({ type: RoleItemDto })
  create(@Body() dto: CreateRoleDto) {
    return this.roleService.createRole(dto)
  }

  @Get(":id")
  @ApiOperation({ summary: "角色详情" })
  @ApiOkResponse({ type: RoleItemDto })
  detail(@Param("id", ParseIntPipe) id: number) {
    return this.roleService.getRole(id)
  }

  @Patch(":id")
  @ApiOperation({ summary: "修改角色（名称/描述/标识色/权限；内置超级管理员不可修改）" })
  @ApiOkResponse({ type: RoleItemDto })
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateRoleDto) {
    return this.roleService.updateRole(id, dto)
  }

  @Delete(":id")
  @ApiOperation({ summary: "删除角色（内置角色 / 有用户的角色不可删）" })
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.roleService.deleteRole(id)
  }

  @Get(":id/users")
  @ApiOperation({ summary: "角色下的用户列表" })
  @ApiOkResponse({ type: RoleUserItemDto, isArray: true })
  users(@Param("id", ParseIntPipe) id: number) {
    return this.roleService.listRoleUsers(id)
  }
}

@ApiTags("角色管理")
@ApiBearerAuth()
@Controller("permissions")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("management.roles")
export class PermissionController {
  constructor(private readonly roleService: RoleService) {}

  @Get()
  @ApiOperation({ summary: "全部权限清单（供角色编辑勾选树）" })
  @ApiOkResponse({ type: MePermissionDto, isArray: true })
  list() {
    return this.roleService.listPermissions()
  }
}
