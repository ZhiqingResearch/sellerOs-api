// src/image-generation/models.controller.ts
//
// GET /api/image-generation/models —— 生图模型下拉聚合端点(轨道 B D6):
// AiGatewayModel 本地目录(IMAGE_GENERATION 类别)。前端下拉唯一数据源。

import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { ImageGenerationModelsService } from "./models.service";

@ApiTags("通用生图")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("image-generation/models")
export class ImageGenerationModelsController {
  constructor(private readonly models: ImageGenerationModelsService) {}

  @Get()
  @ApiOperation({ summary: "生图可用模型(AiGatewayModel 目录,下拉数据源)" })
  list() {
    return this.models.list();
  }
}
