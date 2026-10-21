import { Controller, Get, Query, Request, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { QueryProductDetailDto } from "./dto/query-product-detail.dto"
import { ProductService } from "./product.service"

@ApiTags("产品详情")
@ApiBearerAuth()
@Controller("products")
@UseGuards(JwtAuthGuard)
export class ProductController {
  constructor(private readonly service: ProductService) {}

  @Get("detail")
  @ApiOperation({
    summary: "按 URL 查产品详情",
    description:
      "命中缓存且 fetchedAt 距今 < PRODUCT_CACHE_TTL_DAYS（默认 30 天）直接返回；否则同步调爬虫、写库、返回。爬虫失败抛 502，body 含 { code, message }。",
  })
  detailByUrl(@Request() req: { user: { id: number } }, @Query() query: QueryProductDetailDto) {
    return this.service.findByUrl(req.user.id, query.url)
  }
}
