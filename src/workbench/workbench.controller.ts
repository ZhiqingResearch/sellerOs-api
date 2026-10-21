import { Controller, Get, Query, Request, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { AuthenticatedUser } from "../auth/types"
import { WorkbenchPeriodQueryDto, WorkbenchRecentOutputsQueryDto } from "./dto/workbench-query.dto"
import { WorkbenchService } from "./workbench.service"

/** 卖家工作台：跨功能产出聚合（累计产出/覆盖功能/最近一次/功能分布/最近产出）。可用积分卡由前端直调 GET /api/membership/wallet，不在本接口口径内。 */
@ApiTags("工作台")
@ApiBearerAuth()
@Controller("workbench")
@UseGuards(JwtAuthGuard)
export class WorkbenchController {
  constructor(private readonly workbenchService: WorkbenchService) {}

  @Get("overview")
  @ApiOperation({
    summary: "工作台总览：汇总卡片 + 功能使用分布",
    description:
      "按 period 滚动窗口并发统计各功能产出：totalOutputs=累计产出（各功能 count 之和）；featuresCovered=覆盖功能（周期内有产出的功能数）；totalFeatures=功能总数（含未使用的，作「覆盖功能 X/Y」分母）；lastOutputAt=全时间最近一次产出时间（不随周期筛选，无产出为 null）；distribution=功能使用分布（仅 count>0 的功能，按 count 降序，count=0 不展示）。",
  })
  overview(@Request() req: { user: AuthenticatedUser }, @Query() query: WorkbenchPeriodQueryDto) {
    return this.workbenchService.getOverview(req.user.id, query)
  }

  @Get("recent-outputs")
  @ApiOperation({
    summary: "工作台最近产出：跨功能合并按时间倒序",
    description:
      "各功能取周期内最新 limit 条后内存合并截断，按 occurredAt 倒序。跳转功能历史页由前端按 featureKey + recordId 路由；title 为 null 时展示「未命名」。",
  })
  recentOutputs(
    @Request() req: { user: AuthenticatedUser },
    @Query() query: WorkbenchRecentOutputsQueryDto
  ) {
    return this.workbenchService.getRecentOutputs(req.user.id, query)
  }
}
