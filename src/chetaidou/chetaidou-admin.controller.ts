// 车泰斗素材工作台 — 维护端接口（方案 §5.3）
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common"
import { FileInterceptor } from "@nestjs/platform-express"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { ChetaidouAdminService } from "./chetaidou-admin.service"
import { ChetaidouBillingService } from "./chetaidou-billing.service"

interface AuthedRequest extends Request {
  user: { id: number }
}

class PatchSkuDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  revision: number

  @IsOptional()
  @IsIn([true, false])
  enabled?: boolean

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string
}

class PublishFactDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedRevision: number

  @IsObject()
  content: Record<string, unknown>
}

class ImportPresetImageDto {
  @IsString()
  @MaxLength(200)
  title: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  number?: string

  @IsOptional()
  @IsString()
  @MaxLength(191)
  importKey?: string
}

class ImportBreakdownDto {
  @IsObject()
  payload: Record<string, unknown>

  @IsOptional()
  @IsString()
  @MaxLength(191)
  importKey?: string
}

class RebreakDto {
  @IsUUID()
  idempotencyKey: string
}

class ResolveCallDto {
  @IsIn(["CONFIRMED_FEE", "NOT_ACCEPTED_NO_FEE", "PENDING_PROVIDER_EVIDENCE"])
  conclusion: string

  @IsOptional()
  @IsString()
  @MaxLength(500)
  evidence?: string

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string
}

class ListCallsQueryDto {
  @IsOptional()
  @IsIn(["UNKNOWN", "REVIEW", "PENDING", "DELIVERY"])
  filter?: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page_size: number = 20
}

@ApiTags("admin/chetaidou")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("management.chetaidou")
@Controller("admin/chetaidou")
export class ChetaidouAdminController {
  constructor(
    private readonly service: ChetaidouAdminService,
    private readonly billing: ChetaidouBillingService
  ) {}

  @Get("status")
  @ApiOperation({ summary: "配置、资料可用性与异常调用统计" })
  async getStatus() {
    return this.service.getStatus()
  }

  @Patch("skus/:id")
  @ApiOperation({ summary: "SKU 启停/改名（乐观锁）" })
  async patchSku(@Param("id", ParseIntPipe) id: number, @Body() dto: PatchSkuDto) {
    return this.service.patchSku(id, dto)
  }

  @Get("skus/:id/facts")
  @ApiOperation({ summary: "facts 历史版本" })
  async listFacts(@Param("id", ParseIntPipe) id: number) {
    return this.service.listFacts(id)
  }

  @Post("skus/:id/facts")
  @ApiOperation({ summary: "发布 facts 新版本（content Json + expectedRevision）" })
  async publishFact(
    @Request() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: PublishFactDto
  ) {
    return this.service.publishFact(id, req.user.id, dto)
  }

  @Post("skus/:id/images")
  @ApiOperation({ summary: "导入预置母版（multipart file）" })
  @UseInterceptors(FileInterceptor("file"))
  async importPresetImage(
    @Request() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @UploadedFile() file: { buffer?: Buffer } | undefined,
    @Body() dto: ImportPresetImageDto
  ) {
    if (!file?.buffer?.length) throw new BadRequestException("缺少上传文件")
    return this.service.importPresetImage(id, req.user.id, { buffer: file.buffer }, dto)
  }

  @Post("images/:id/breakdowns")
  @ApiOperation({ summary: "导入固定拆解 JSON（追加 PRESET/CONFIRMED 版本）" })
  async importBreakdown(
    @Request() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: ImportBreakdownDto
  ) {
    return this.service.importBreakdown(id, req.user.id, dto)
  }

  @Post("images/:id/rebreak")
  @ApiOperation({ summary: "触发 AI 重新拆解（保持 AI_UNREVIEWED）" })
  async rebreak(
    @Request() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RebreakDto
  ) {
    return this.service.rebreak(id, req.user.id, dto.idempotencyKey)
  }

  @Post("images/:id/breakdowns/:bid/publish")
  @ApiOperation({ summary: "人工确认 AI 稿（追加 CONFIRMED 版本）" })
  async publishBreakdown(
    @Request() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Param("bid", ParseIntPipe) bid: number
  ) {
    return this.service.publishBreakdown(id, bid, req.user.id)
  }

  @Get("calls")
  @ApiOperation({ summary: "异常调用列表（UNKNOWN/REVIEW/待结算/待转存）" })
  async listCalls(@Query() query: ListCallsQueryDto) {
    return this.service.listCalls({
      filter: query.filter,
      page: query.page,
      pageSize: query.page_size,
    })
  }

  @Post("calls/:id/reconcile")
  @ApiOperation({ summary: "单个调用核对（只查询，不创建收费请求）" })
  async reconcileCall(@Param("id") id: string) {
    return this.service.reconcileCall(id, this.billing)
  }

  @Post("calls/:id/resolve")
  @ApiOperation({ summary: "人工核对落账（绑定证据/登记未受理）" })
  async resolveCall(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
    @Body() dto: ResolveCallDto
  ) {
    return this.service.resolveCall(id, req.user.id, dto)
  }
}
