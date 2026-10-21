import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { BatchCreateProductLibraryItemsDto } from "./dto/batch-create-product-library-items.dto"
import { CreateProductLibraryItemDto } from "./dto/create-product-library-item.dto"
import { QueryProductLibraryItemDto } from "./dto/query-product-library-item.dto"
import { UpdateProductLibraryItemDto } from "./dto/update-product-library-item.dto"
import { ProductLibraryService } from "./product-library.service"

@ApiTags("选品商品库")
@ApiBearerAuth()
@Controller("product-library/items")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("tool.flow_workbench")
export class ProductLibraryController {
  constructor(private readonly service: ProductLibraryService) {}

  @Post()
  @ApiOperation({ summary: "存入单个商品画像" })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateProductLibraryItemDto) {
    return this.service.create(req.user.id, dto)
  }

  @Post("batch")
  @ApiOperation({ summary: "批量存入商品画像（最多100条，整体事务）" })
  createBatch(
    @Request() req: { user: { id: number } },
    @Body() dto: BatchCreateProductLibraryItemsDto
  ) {
    return this.service.createBatch(req.user.id, dto)
  }

  @Get()
  @ApiOperation({ summary: "分页查询当前用户的商品库" })
  findAll(@Request() req: { user: { id: number } }, @Query() query: QueryProductLibraryItemDto) {
    return this.service.findAll(req.user.id, query)
  }

  @Get(":id")
  @ApiOperation({ summary: "查询商品及来源画像详情" })
  findOne(@Request() req: { user: { id: number } }, @Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(req.user.id, id)
  }

  @Patch(":id")
  @ApiOperation({ summary: "修改商品标签和备注" })
  update(
    @Request() req: { user: { id: number } },
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateProductLibraryItemDto
  ) {
    return this.service.update(req.user.id, id, dto)
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "软删除商品库记录" })
  remove(@Request() req: { user: { id: number } }, @Param("id", ParseIntPipe) id: number) {
    return this.service.remove(req.user.id, id)
  }
}
