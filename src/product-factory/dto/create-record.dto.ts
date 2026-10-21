import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from "class-validator"

/** Amazon 链接（含 amazon. 域名）或 10 位字母数字 ASIN */
const AMAZON_URL_OR_ASIN = /^(?:https?:\/\/\S*amazon\.\S*|[A-Za-z0-9]{10})$/i

/**
 * 我方产品资料文档（前端解析出的文本，供拆解注入 LLM）。
 * 仅作 Swagger 形状说明；运行时对 documents 做元素级宽松校验（@IsObject），
 * 避免 whitelist 剥离前端未同步到后端的新字段。
 */
export class ProductDocumentDto {
  @ApiProperty({ example: "规格表.txt", description: "文件名" })
  @IsString()
  name: string

  @ApiProperty({
    example: "容量 400ml / USB-C 充电…",
    description: "解析出的文本内容（前端已截断）",
  })
  @IsString()
  content: string
}

/**
 * 采购链接解析结果（平台 + 规格 / 货描 / 采购价）。
 * 仅作 Swagger 形状说明；运行时宽松校验（@IsObject），不剥字段。
 */
export class PurchaseInfoDto {
  @ApiProperty({ example: "1688", description: "识别出的平台名" })
  @IsString()
  platform: string

  @ApiPropertyOptional({ example: "400ml / 6 刀头 / USB-C", description: "规格参数" })
  @IsOptional()
  @IsString()
  specs?: string

  @ApiPropertyOptional({ example: "便携榨汁杯，无线电动…", description: "货描" })
  @IsOptional()
  @IsString()
  description?: string

  @ApiPropertyOptional({ example: "¥12.50（2 件起批）", description: "采购价" })
  @IsOptional()
  @IsString()
  price?: string
}

export class OurProductDto {
  @ApiPropertyOptional({ example: "便携榨汁杯 400ml", description: "我方产品名称" })
  @IsOptional()
  @IsString()
  name?: string

  @ApiPropertyOptional({ example: "BlendGo", description: "品牌名" })
  @IsOptional()
  @IsString()
  brand?: string

  @ApiPropertyOptional({ example: "https://www.amazon.com/dp/B0ABCDEFGH", description: "购买链接" })
  @IsOptional()
  @IsString()
  purchaseUrl?: string

  @ApiPropertyOptional({
    example: "https://oss.example.com/spec.pdf",
    description: "产品资料文档链接",
  })
  @IsOptional()
  @IsString()
  documentUrl?: string

  @ApiPropertyOptional({
    example: ["https://oss.example.com/p1.jpg"],
    description: "产品图片 URL 列表",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  productImages?: string[]

  @ApiPropertyOptional({
    type: [ProductDocumentDto],
    description: "产品资料文档（解析文本，宽松校验）",
  })
  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  documents?: Record<string, unknown>[]

  @ApiPropertyOptional({ type: PurchaseInfoDto, description: "采购链接解析结果（宽松校验）" })
  @IsOptional()
  @IsObject()
  purchaseInfo?: Record<string, unknown>
}

export class SourceInputDto {
  @ApiProperty({
    example: ["https://www.amazon.com/dp/B0C1X2Y3Z4"],
    description:
      "竞品 Amazon 链接或 10 位 ASIN，1~3 个；自有商品来源可为空（服务层按来源校验最少数量）",
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @Matches(AMAZON_URL_OR_ASIN, {
    each: true,
    message: "competitorUrls 元素必须是 Amazon 链接或 10 位字母数字 ASIN",
  })
  competitorUrls?: string[]

  @ApiProperty({
    example: "amazon_us",
    description: "目标站点",
    enum: ["amazon_us", "amazon_uk", "amazon_de"],
  })
  @IsIn(["amazon_us", "amazon_uk", "amazon_de"])
  market: string

  @ApiPropertyOptional({ type: OurProductDto, description: "我方产品信息（可选）" })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => OurProductDto)
  ourProduct?: OurProductDto
}

export class CreateRecordDto {
  @ApiProperty({
    example: "competitor",
    description: "来源类型（当前支持 competitor / own_product）",
    enum: ["competitor", "own_product"],
  })
  @IsIn(["competitor", "own_product"], {
    message: "sourceType 仅支持 competitor / own_product",
  })
  sourceType: string

  @ApiProperty({ type: SourceInputDto, description: "来源原始输入" })
  @IsObject()
  @ValidateNested()
  @Type(() => SourceInputDto)
  sourceInput: SourceInputDto
}
