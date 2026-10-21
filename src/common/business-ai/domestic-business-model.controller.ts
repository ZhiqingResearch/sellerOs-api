import { Controller, Get, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard"
import { DomesticBusinessModels } from "./domestic-business-models"

@ApiTags("业务 AI 模型")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("business-ai/models")
export class DomesticBusinessModelController {
  constructor(private readonly models: DomesticBusinessModels) {}

  @Get()
  @ApiOperation({ summary: "Listing、竞品分析、新品推广及智能定价可选国产模型" })
  findAll() {
    return this.models.findAll()
  }
}
