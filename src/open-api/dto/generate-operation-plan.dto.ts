import { ApiProperty } from "@nestjs/swagger"
import { Transform } from "class-transformer"
import { IsString, IsUrl, Matches, MaxLength } from "class-validator"

export class GenerateOperationPlanDto {
  @ApiProperty({
    example: "https://www.amazon.com/dp/B09VLJJPL6",
    description: "唯一业务入参：Amazon 商品详情链接；服务端自动解析站点和ASIN",
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsUrl({ protocols: ["https", "http"], require_protocol: true })
  @MaxLength(2048)
  url: string
}

export class OperationPlanRequestParamsDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  requestId: string
}
