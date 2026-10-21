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
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { PaginationDto } from "../common/dto/pagination.dto"
import { CreateProductReportDto } from "./dto/create-product-report.dto"
import { ProductReportService } from "./product-report.service"

@ApiTags("产品分析报告")
@ApiBearerAuth()
@Controller("product-report")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("management.product.reports")
export class ProductReportController {
  constructor(private readonly productReportService: ProductReportService) {}

  @Get()
  @ApiOperation({ summary: "获取产品分析报告列表" })
  findAll(@Request() req: { user: { id: number } }, @Query() query: PaginationDto) {
    return this.productReportService.findByUser(req.user.id, query)
  }

  @Get(":id")
  @ApiOperation({ summary: "查询产品分析报告详情" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.productReportService.findById(id)
  }

  @Post()
  @ApiOperation({ summary: "创建产品分析报告" })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateProductReportDto) {
    return this.productReportService.create(req.user.id, dto)
  }

  @Delete(":id")
  @ApiOperation({ summary: "删除产品分析报告" })
  remove(@Param("id", ParseIntPipe) id: number, @Request() req: { user: { id: number } }) {
    return this.productReportService.remove(id, req.user.id)
  }
}
