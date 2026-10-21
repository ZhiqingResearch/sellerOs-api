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
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import {
  CreateImageTemplateDto,
  QuerySystemTemplateDto,
  UpdateImageTemplateDto,
} from "./image-template.dto"
import { ImageTemplateService } from "./image-template.service"

interface AuthedRequest {
  user: { id: number; phone: string; roleCode: string | null }
}

@ApiTags("图片创作 - 系统模板管理")
@ApiBearerAuth()
@Controller("image-project/system-templates")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("management.prompt_library")
export class SystemImageTemplateController {
  constructor(private readonly service: ImageTemplateService) {}

  @ApiOperation({ summary: "系统模板分组列表（含计数），管理页分组筛选 Tab 使用" })
  @Get("groups")
  findGroups() {
    return this.service.findGroupsSystem()
  }

  @ApiOperation({ summary: "系统模板列表（内置提示词管理 · 模板 Tab）" })
  @Get()
  findAll(@Query() query: QuerySystemTemplateDto) {
    return this.service.findAllSystem(query)
  }

  @ApiOperation({ summary: "新建系统模板" })
  @Post()
  create(@Body() dto: CreateImageTemplateDto, @Request() req: AuthedRequest) {
    return this.service.createSystem(dto, req.user.id)
  }

  @ApiOperation({ summary: "编辑系统模板（传 items 时整组替换）" })
  @Patch(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateImageTemplateDto) {
    return this.service.updateSystem(id, dto)
  }

  @ApiOperation({ summary: "删除系统模板（软删除）" })
  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.removeSystem(id)
  }
}
