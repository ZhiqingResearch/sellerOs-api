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
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import {
  CreatePromptTemplateDto,
  GroupedPromptTemplateQueryDto,
  ListPromptTemplateQueryDto,
  UpdatePromptTemplateDto,
} from "./prompt-template.dto"
import { PromptTemplateService } from "./prompt-template.service"

@ApiTags("图片创作 - 内置提示词管理")
@ApiBearerAuth()
@Controller("image-project/prompt-templates")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("management.prompt_library")
export class PromptTemplateController {
  constructor(private readonly service: PromptTemplateService) {}

  // 静态路径放在 /:id 之前，避免被参数路由吞掉

  @ApiOperation({ summary: "按维度分组列表（admin Tab + 前端 Composer 共用）" })
  @Get("grouped")
  findGrouped(@Query() query: GroupedPromptTemplateQueryDto) {
    return this.service.findGrouped(query)
  }

  @ApiOperation({ summary: "维度列表（distinct + count），新增弹窗下拉框使用" })
  @Get("dimensions")
  findDimensions() {
    return this.service.findDimensions()
  }

  @ApiOperation({ summary: "提示词模板分页列表" })
  @Get()
  findAll(@Query() query: ListPromptTemplateQueryDto) {
    return this.service.findAll(query)
  }

  @ApiOperation({ summary: "新增提示词模板" })
  @Post()
  create(@Body() dto: CreatePromptTemplateDto) {
    return this.service.create(dto)
  }

  @ApiOperation({ summary: "更新提示词模板（含 enabled 开关切换）" })
  @Patch(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdatePromptTemplateDto) {
    return this.service.update(id, dto)
  }

  @ApiOperation({ summary: "删除提示词模板（硬删除）" })
  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.service.remove(id)
  }
}
