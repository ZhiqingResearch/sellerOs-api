import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { SaveImageCropDto } from "./image-crop.dto"
import { ImageCropService } from "./image-crop.service"

@ApiTags("图片创作-裁剪保存")
@ApiBearerAuth()
@Controller("image-project")
@UseGuards(JwtAuthGuard)
export class ImageCropController {
  constructor(private readonly service: ImageCropService) {}

  @Post("crops/upload-url")
  @HttpCode(200)
  @ApiOperation({ summary: "获取本人裁剪 PNG 的公开直传凭证" })
  uploadUrl(@Request() req: { user: { id: number } }) {
    return this.service.uploadUrl(req.user.id)
  }

  @Post(":id/crops")
  @HttpCode(200)
  @ApiOperation({ summary: "保存裁剪成品到原项目（支持人像及已归档批量改图，不生成、不扣费）" })
  save(
    @Param("id", ParseIntPipe) projectId: number,
    @Body() dto: SaveImageCropDto,
    @Request() req: { user: { id: number } }
  ) {
    return this.service.save(projectId, dto, req.user.id)
  }
}
