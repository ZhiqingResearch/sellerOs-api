import { Controller, Get, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { CatalogService } from "./catalog.service"

/** 商品目录（个人套餐/充值包/团队套餐/团队包/自定义阶梯 + 单价/折扣标签）。 */
@ApiTags("商品目录")
@ApiBearerAuth()
@Controller("billing/catalog")
@UseGuards(JwtAuthGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @ApiOperation({
    summary: "商品目录（价格/积分/单价/折扣标签均由后端算好下发，前端只渲染）",
  })
  get() {
    return this.catalog.getCatalog()
  }
}
