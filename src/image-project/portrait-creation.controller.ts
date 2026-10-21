import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import {
  CreatePortraitTaskDto,
  PortraitImageIdsDto,
  SavePortraitTemplateDto,
} from "./portrait-creation.dto"
import { PortraitCreationService } from "./portrait-creation.service"

interface AuthedRequest {
  user: { id: number; phone: string; roleCode: string | null }
}

@ApiTags("图片创作-人像创作")
@ApiBearerAuth()
@Controller("image-project")
@UseGuards(JwtAuthGuard)
export class PortraitCreationController {
  constructor(private readonly service: PortraitCreationService) {}

  @ApiOperation({ summary: "创建人像生成任务；尺寸适配和后处理由后端完成" })
  @Post(":id/portrait/tasks")
  @HttpCode(HttpStatus.ACCEPTED)
  createTask(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: CreatePortraitTaskDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.createTask(projectId, dto, req.user.id)
  }

  @ApiOperation({ summary: "按历史图片读取人像编辑回填上下文" })
  @Get("generated-image/:imageId/context")
  findImageContext(@Param("imageId", ParseIntPipe) imageId: number, @Request() req: AuthedRequest) {
    return this.service.findImageContext(imageId, req.user.id)
  }

  @ApiOperation({ summary: "校验所选人像图片并返回批量下载清单" })
  @Post(":id/generated-images/batch-download")
  batchDownload(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: PortraitImageIdsDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.batchDownload(projectId, dto, req.user.id)
  }

  @ApiOperation({ summary: "将多张人像图片创建为一个多图模板或批量追加到模板" })
  @Post(":id/generated-images/save-to-template")
  saveToTemplate(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: SavePortraitTemplateDto,
    @Request() req: AuthedRequest
  ) {
    return this.service.saveToTemplate(projectId, dto, req.user.id)
  }
}
