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
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { CreateRecordDto } from "./dto/create-record.dto"
import { QueryRecordDto } from "./dto/query-record.dto"
import { UpdateRecordDto } from "./dto/update-record.dto"
import { ProductFactoryService } from "./product-factory.service"

@ApiTags("AI商品工厂")
@ApiBearerAuth()
@Controller("product-factory")
@UseGuards(JwtAuthGuard)
export class ProductFactoryController {
  constructor(private readonly productFactoryService: ProductFactoryService) {}

  @Get("records")
  @ApiOperation({ summary: "制作记录列表" })
  findAll(@Request() req: { user: { id: number } }, @Query() query: QueryRecordDto) {
    return this.productFactoryService.findAll(req.user.id, query)
  }

  @Post("records")
  @ApiOperation({ summary: "创建制作记录" })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateRecordDto) {
    return this.productFactoryService.create(req.user.id, dto)
  }

  @Get("records/:id")
  @ApiOperation({ summary: "制作记录详情" })
  findOne(@Request() req: { user: { id: number } }, @Param("id", ParseIntPipe) id: number) {
    return this.productFactoryService.findOne(req.user.id, id)
  }

  @Patch("records/:id")
  @ApiOperation({ summary: "更新制作记录（保存步骤数据）" })
  update(
    @Request() req: { user: { id: number } },
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateRecordDto
  ) {
    return this.productFactoryService.update(req.user.id, id, dto)
  }

  @Delete("records/:id")
  @HttpCode(204)
  @ApiOperation({ summary: "删除制作记录（软删除）" })
  remove(@Request() req: { user: { id: number } }, @Param("id", ParseIntPipe) id: number) {
    return this.productFactoryService.remove(req.user.id, id)
  }
}
