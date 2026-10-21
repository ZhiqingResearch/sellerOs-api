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
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { QueryBrandKitDto, SaveBrandKitDto } from "./brand-kit.dto"
import { BrandKitService } from "./brand-kit.service"

interface AuthedRequest {
  user: { id: number; phone: string; roleCode: string | null }
}

@ApiTags("品牌库")
@ApiBearerAuth()
@Controller("brand-kit")
@UseGuards(JwtAuthGuard)
export class BrandKitController {
  constructor(private readonly service: BrandKitService) {}

  @ApiOperation({ summary: "保存当前品牌基因到品牌库（允许同名）" })
  @Post()
  create(@Body() dto: SaveBrandKitDto, @Request() req: AuthedRequest) {
    return this.service.create(dto, req.user.id)
  }

  @ApiOperation({ summary: "品牌库列表（搜索 + 分页，返回全字段供前端回填）" })
  @Get()
  findAll(@Query() query: QueryBrandKitDto, @Request() req: AuthedRequest) {
    return this.service.findAll(query, req.user.id)
  }

  @ApiOperation({ summary: "删除品牌库记录" })
  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number, @Request() req: AuthedRequest) {
    return this.service.remove(id, req.user.id)
  }
}
