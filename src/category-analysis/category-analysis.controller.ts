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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common"
import { FileInterceptor } from "@nestjs/platform-express"
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { CategoryAnalysisService } from "./category-analysis.service"
import {
  ConfirmCategoryCandidatesDto,
  CreateCategoryAnalysisDto,
  ImportCategorySampleDto,
  QueryCategoryAnalysisDto,
} from "./dto/create-category-analysis.dto"

@ApiTags("类目分析")
@ApiBearerAuth()
@Controller("category-analysis")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("tool.category_analysis")
export class CategoryAnalysisController {
  constructor(private readonly service: CategoryAnalysisService) {}
  @Post()
  @ApiOperation({ summary: "提交类目分析（异步执行，按实际 AI 账单扣费）" })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateCategoryAnalysisDto) {
    return this.service.create(req.user.id, dto)
  }
  @Get()
  @ApiOperation({ summary: "查询本人类目分析历史" })
  findAll(@Request() req: { user: { id: number } }, @Query() query: QueryCategoryAnalysisDto) {
    return this.service.findAll(req.user.id, query)
  }
  @Post("samples")
  @ApiOperation({ summary: "保留的样本导入接口（页面不展示入口）" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file", "categoryId", "marketplace"],
      properties: {
        file: { type: "string", format: "binary" },
        categoryId: { type: "string" },
        marketplace: { type: "string", enum: ["US", "UK", "DE", "JP"] },
      },
    },
  })
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  importSample(
    @Request() req: { user: { id: number } },
    @Body() dto: ImportCategorySampleDto,
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined
  ) {
    return this.service.importSample(req.user.id, dto, file)
  }
  @Post(":id/categories")
  @ApiOperation({ summary: "确认关键词反查候选类目并继续分析" })
  confirmCandidates(
    @Request() req: { user: { id: number } },
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: ConfirmCategoryCandidatesDto
  ) {
    return this.service.confirmCandidates(req.user.id, id, dto.categoryIds)
  }
  @Get(":id")
  @ApiOperation({ summary: "轮询任务 / 获取本人报告" })
  findOne(@Request() req: { user: { id: number } }, @Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(req.user.id, id)
  }
  @Delete(":id")
  @ApiOperation({ summary: "软删除本人已结束的分析" })
  remove(@Request() req: { user: { id: number } }, @Param("id", ParseIntPipe) id: number) {
    return this.service.remove(req.user.id, id)
  }
}
