import { Controller, Get, Param, Request, UseGuards } from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { OpenApiApp } from "@prisma/client"
import { OperationPlanRequestParamsDto } from "./dto/generate-operation-plan.dto"
import { OpenApiAuthGuard } from "./open-api-auth.guard"
import { OpenOperationPlanService } from "./open-operation-plan.service"

@ApiTags("开放接口-牛牛运营计划")
@Controller("open/operation-plans")
@UseGuards(OpenApiAuthGuard)
export class OpenOperationPlanController {
  constructor(private readonly service: OpenOperationPlanService) {}

  @Get(":requestId")
  @ApiOperation({
    summary: "仅兼容读取本接入方旧生成快照，不用于竞品运营详情查询",
    deprecated: true,
  })
  findOne(
    @Request() req: { openApiApp: OpenApiApp },
    @Param() params: OperationPlanRequestParamsDto
  ) {
    return this.service.findOne(req.openApiApp, params.requestId)
  }
}
