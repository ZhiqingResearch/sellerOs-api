import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { BulkDeleteSensitiveWordDto } from "./dto/bulk-delete-sensitive-word.dto"
import { CreateSensitiveWordDto } from "./dto/create-sensitive-word.dto"
import { QuerySensitiveWordDto } from "./dto/query-sensitive-word.dto"
import { StatsQueryDto } from "./dto/stats-query.dto"
import { UpdateSensitiveWordDto } from "./dto/update-sensitive-word.dto"
import { SensitiveWordService } from "./sensitive-word.service"

const MANAGE_PERMISSION = "management.sensitive_words"

@ApiTags("敏感词提示库")
@ApiBearerAuth()
@Controller("sensitive-words")
@UseGuards(JwtAuthGuard)
export class SensitiveWordController {
  constructor(private readonly service: SensitiveWordService) {}

  @Post()
  @ApiOperation({
    summary: "创建敏感词（word/category 均为数组，支持批量）",
    description: [
      "登录用户即可调用；userId 取当前用户。",
      "word 数组由前端拆好传入（后端会 trim/过空/去重）；category 数组可多选；其余字段对该批所有 word 共享。",
      "source 可选：MANUAL / LISTING_GENERATION / AI_DETECTION，不传缺省 MANUAL。",
      "返回 { created: [...], conflicts: [...] }，conflicts 列出因 (platform, word) 已存在被跳过的词；全部冲突时返回 409。",
    ].join(" "),
  })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateSensitiveWordDto) {
    return this.service.create(req.user.id, dto)
  }

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(MANAGE_PERMISSION)
  @ApiOperation({
    summary: "分页查询敏感词",
    description: "支持按平台、分类、敏感词模糊、来源、创建人多维筛选。",
  })
  findAll(@Query() query: QuerySensitiveWordDto) {
    return this.service.findAll(query)
  }

  @Get("stats")
  @UseGuards(PermissionsGuard)
  @RequirePermissions(MANAGE_PERMISSION)
  @ApiOperation({
    summary: "敏感词总数 + 每平台分类分布（一次返回）",
    description: [
      "返回 { total, platforms[{ key, count, categories[{ key, count }] }] }。",
      "前端切平台 tab 直接读 platforms[i].categories，不再回源。",
      "可选过滤：source / userId（横切，影响 total + platforms[].count + categories[].count）。",
      "platform 不作为过滤项（它是返回结构的 tab 维度）。",
      "注意 category 是 JSON 数组：一条记录可能挂多个分类 → sum(categories[].count) ≥ platform.count。",
    ].join(" "),
  })
  stats(@Query() query: StatsQueryDto) {
    return this.service.stats(query)
  }

  @Get("users")
  @UseGuards(PermissionsGuard)
  @RequirePermissions(MANAGE_PERMISSION)
  @ApiOperation({
    summary: "列出所有创建过敏感词的用户（id + username）",
    description: "供前端筛选下拉使用；按 username 升序；不分页。",
  })
  usersWithSensitiveWords() {
    return this.service.findUsersWithSensitiveWords()
  }

  @Get(":id")
  @UseGuards(PermissionsGuard)
  @RequirePermissions(MANAGE_PERMISSION)
  @ApiOperation({ summary: "查询敏感词详情" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.service.findById(id)
  }

  @Patch(":id")
  @UseGuards(PermissionsGuard)
  @RequirePermissions(MANAGE_PERMISSION)
  @ApiOperation({ summary: "更新敏感词" })
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateSensitiveWordDto) {
    return this.service.update(id, dto)
  }

  @Post("bulk-delete")
  @HttpCode(200)
  @UseGuards(PermissionsGuard)
  @RequirePermissions(MANAGE_PERMISSION)
  @ApiOperation({
    summary: "批量删除敏感词（物理删除）",
    description:
      "Body: { ids: number[] }；1-1000 个正整数 id。返回 { deleted, requested, missing }，missing 列出请求里但 DB 不存在的 id（不报错）。",
  })
  bulkDelete(@Body() dto: BulkDeleteSensitiveWordDto) {
    const ids = Array.from(new Set(dto.ids))
    return this.service.removeMany(ids)
  }
}
