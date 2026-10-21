import { Body, Controller, Post, Request, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { CreateSelectedProductsDto } from "./dto/create-selected-products.dto"
import { SelectedProductService } from "./selected-product.service"

@ApiTags("筛选产品")
@ApiBearerAuth()
@Controller("selected-product")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("tool.flow_workbench")
export class SelectedProductController {
  constructor(private readonly selectedProductService: SelectedProductService) {}

  @Post("batch")
  @ApiOperation({ summary: "批量创建筛选产品" })
  createBatch(@Request() req: { user: { id: number } }, @Body() dto: CreateSelectedProductsDto) {
    return this.selectedProductService.createBatch(req.user.id, dto)
  }
}
