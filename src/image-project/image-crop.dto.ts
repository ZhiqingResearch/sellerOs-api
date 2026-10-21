import { ApiProperty } from "@nestjs/swagger"
import { IsInt, IsUrl, IsUUID, Max, MaxLength, Min } from "class-validator"

export class SaveImageCropDto {
  @ApiProperty({ description: "一次保存动作的 UUID；失败重试沿用" })
  @IsUUID()
  idempotencyKey!: string

  @ApiProperty({ description: "本项目 generatedImages[].id，不是任务或 Job ID" })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sourceImageId!: number

  @ApiProperty({ description: "裁剪直传凭证返回的 publicUrl，上传 PNG 完成后提交" })
  @IsUrl({ protocols: ["https"], require_protocol: true })
  @MaxLength(1000)
  url!: string
}
