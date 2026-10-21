import { Controller, Get, Param, Request, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard"
import { BusinessAiService } from "./business-ai.service"

@ApiTags("AI 运行恢复")
@ApiBearerAuth()
@Controller("business-ai/runs")
@UseGuards(JwtAuthGuard)
export class BusinessAiRunController {
  constructor(private readonly businessAiService: BusinessAiService) {}

  @Get(":runId")
  @ApiOperation({ summary: "按运行号读取已保存的 AI 原始产出，不重新调用模型" })
  findRun(@Request() request: { user: { id: number } }, @Param("runId") runId: string) {
    return this.businessAiService.findRun(request.user.id, runId)
  }
}
