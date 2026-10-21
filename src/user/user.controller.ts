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
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { CreateUserDto } from "./dto/create-user.dto"
import { QueryUserDto } from "./dto/query-user.dto"
import { UpdateUserDto } from "./dto/update-user.dto"
import { BatchCreateUserDto, MoveOrgDto, UpdateUserStatusDto } from "./dto/user-misc.dto"
import { RoleOptionDto, UserItemDto, UserListDto } from "./dto/user-response.dto"
import { UserService } from "./user.service"

@ApiTags("用户管理")
@ApiBearerAuth()
@Controller("users")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("management.users")
export class UserController {
  constructor(private readonly usersService: UserService) {}

  @Get()
  @ApiOperation({ summary: "用户列表（分页 / 关键词 / 组织筛选）" })
  @ApiOkResponse({ type: UserListDto })
  list(@Query() query: QueryUserDto) {
    return this.usersService.list(query)
  }

  // 注意：必须声明在 @Get(":id") 之前，否则会被参数路由抢匹配
  @Get("role-options")
  @ApiOperation({ summary: "可分配的角色选项（供用户表单下拉，management.users 即可访问）" })
  @ApiOkResponse({ type: RoleOptionDto, isArray: true })
  roleOptions() {
    return this.usersService.listRoleOptions()
  }

  @Post()
  @ApiOperation({ summary: "新建用户" })
  @ApiOkResponse({ type: UserItemDto })
  create(@Body() dto: CreateUserDto) {
    return this.usersService.createUser(dto)
  }

  @Post("batch")
  @ApiOperation({ summary: "批量新建用户" })
  @ApiOkResponse({ type: UserItemDto, isArray: true })
  batchCreate(@Body() dto: BatchCreateUserDto) {
    return this.usersService.batchCreate(dto)
  }

  @Post("move-org")
  @ApiOperation({ summary: "批量把用户挂到组织（replace=false 加入 / true 替换）" })
  moveOrg(@Body() dto: MoveOrgDto) {
    return this.usersService.moveToOrg(dto)
  }

  @Get(":id/phone")
  @ApiOperation({ summary: "查看用户手机号全号（敏感操作，每次写审计日志）" })
  fullPhone(@Param("id", ParseIntPipe) id: number, @Request() req: { user: { id: number } }) {
    return this.usersService.getFullPhone(id, req.user.id)
  }

  @Get(":id")
  @ApiOperation({ summary: "用户详情" })
  @ApiOkResponse({ type: UserItemDto })
  detail(@Param("id", ParseIntPipe) id: number) {
    return this.usersService.getUser(id)
  }

  @Patch(":id")
  @ApiOperation({ summary: "修改用户（用户名 / 角色 / 组织）" })
  @ApiOkResponse({ type: UserItemDto })
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    return this.usersService.updateUser(id, dto)
  }

  @Post(":id/reset-password")
  @ApiOperation({ summary: "重置密码为默认密码" })
  resetPassword(@Param("id", ParseIntPipe) id: number) {
    return this.usersService.resetPassword(id)
  }

  @Patch(":id/status")
  @ApiOperation({ summary: "停用 / 启用用户" })
  @ApiOkResponse({ type: UserItemDto })
  setStatus(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateUserStatusDto) {
    return this.usersService.setStatus(id, dto.isActive)
  }
}
