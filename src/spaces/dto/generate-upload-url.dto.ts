import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator"

export class GenerateUploadUrlDto {
  @ApiProperty({ description: "上传后端的原始文件名（仅用于保留扩展名）", example: "cover.png" })
  @IsString()
  @IsNotEmpty()
  filename: string

  @ApiPropertyOptional({
    description: "文件 MIME 类型，传入则签名绑定，前端 PUT 时必须带相同 Content-Type",
    example: "image/png",
  })
  @IsOptional()
  @IsString()
  contentType?: string

  @ApiPropertyOptional({
    description: "上传目录前缀（默认 uploads/），最终 key = `${keyPrefix}${uuid}${ext}`",
    example: "avatars/",
  })
  @IsOptional()
  @IsString()
  keyPrefix?: string

  @ApiPropertyOptional({ description: "签名有效期（秒），默认 3600（1 小时）", example: 3600 })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(7 * 24 * 3600)
  expiresIn?: number
}
