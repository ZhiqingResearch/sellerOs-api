import { Body, Controller, Post, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { randomUUID } from "crypto"
import * as path from "path"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { GenerateUploadUrlDto } from "./dto/generate-upload-url.dto"
import { SpacesService } from "./spaces.service"

@ApiTags("Spaces")
@ApiBearerAuth()
@Controller("spaces")
@UseGuards(JwtAuthGuard)
export class SpacesController {
  constructor(private readonly spacesService: SpacesService) {}

  @ApiOperation({
    summary: "生成 Presigned PUT URL",
    description:
      "前端 `fetch(uploadUrl, { method: 'PUT', body: file, headers })` 直传到 DigitalOcean Spaces。" +
      " 上传成功（HTTP 200）后用 `publicUrl` 访问文件。",
  })
  @Post("upload-url")
  async generateUploadUrl(@Body() dto: GenerateUploadUrlDto) {
    const ext = path.extname(dto.filename).toLowerCase()
    const prefix = dto.keyPrefix?.replace(/^\/+/, "") ?? "uploads/"
    const dir = prefix.endsWith("/") ? prefix : `${prefix}/`
    const key = `${dir}${randomUUID()}${ext}`

    return this.spacesService.generateUploadUrl({
      key,
      contentType: dto.contentType,
      expiresIn: dto.expiresIn,
    })
  }
}
