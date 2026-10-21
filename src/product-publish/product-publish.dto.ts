import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "../common/dto/pagination.dto"
import {
  PRODUCT_PUBLISH_STATUSES,
  PRODUCT_PUBLISH_TYPES,
  WASH_STATUSES,
} from "./product-publish.constants"

export class ProductPublishImageDto {
  @ApiPropertyOptional({ description: "前端图片标识" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  id?: string

  @ApiProperty({ description: "原始图片链接" })
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  @MaxLength(2000)
  originalUrl: string

  @ApiPropertyOptional({ description: "第三方洗链后的图片链接" })
  @IsOptional()
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  @MaxLength(2000)
  washedUrl?: string

  @ApiPropertyOptional({ enum: WASH_STATUSES, description: "洗链状态" })
  @IsOptional()
  @IsIn(WASH_STATUSES as readonly string[])
  washStatus?: (typeof WASH_STATUSES)[number]

  @ApiPropertyOptional({ description: "洗链失败原因" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  errorMessage?: string
}

export class CreateProductPublishTaskDto {
  @ApiPropertyOptional({ description: "关联的图片项目 ID；创建草稿时可不传" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  imageProjectId?: number

  @ApiPropertyOptional({ description: "商品名" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  productName?: string

  @ApiPropertyOptional({ description: "品牌" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  brand?: string

  @ApiPropertyOptional({
    example: "NOTEBOOK COMPUTER",
    description: "一级分类编码；配置店铺ID时会校验该店铺是否已开通此分类",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9]+(?: [A-Z0-9]+)*$/, {
    message: "分类编码只能包含大写字母、数字和单个空格",
  })
  @MaxLength(100)
  classification?: string

  @ApiPropertyOptional({ description: "完整类目文本，支持一级/二级类目路径" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  category?: string

  @ApiPropertyOptional({ description: "前端一键上架业务数据" })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>

  @ApiPropertyOptional({ description: "店铺名称字符串，如 A店、B店" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  store?: string

  @ApiPropertyOptional({
    example: "27826971599669",
    description: "飞书同步的业务店铺ID；按字符串传递，避免大整数精度丢失",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: "店铺ID必须为纯数字字符串" })
  @MaxLength(32)
  storeId?: string

  @ApiPropertyOptional({ enum: PRODUCT_PUBLISH_TYPES, description: "SINGLE 单体 / VARIANT 多变体" })
  @IsOptional()
  @IsIn(PRODUCT_PUBLISH_TYPES as readonly string[])
  type?: (typeof PRODUCT_PUBLISH_TYPES)[number]

  @ApiPropertyOptional({ type: [ProductPublishImageDto], description: "商品图片" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProductPublishImageDto)
  productImages?: ProductPublishImageDto[]

  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: "完成进度（前端计算）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number
}

export class UpdateProductPublishTaskDto extends PartialType(CreateProductPublishTaskDto) {}

export class QueryProductPublishRecordsDto extends PaginationDto {
  @ApiPropertyOptional({ description: "同时模糊匹配商品名、品牌、完整类目" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  keyword?: string

  @ApiPropertyOptional({ enum: PRODUCT_PUBLISH_STATUSES })
  @IsOptional()
  @IsIn(PRODUCT_PUBLISH_STATUSES as readonly string[])
  status?: (typeof PRODUCT_PUBLISH_STATUSES)[number]

  @ApiPropertyOptional({ description: "店铺名称精确筛选" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  store?: string

  @ApiPropertyOptional({ description: "业务店铺ID精确筛选", example: "27826971599669" })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: "店铺ID必须为纯数字字符串" })
  @MaxLength(32)
  storeId?: string

  @ApiPropertyOptional({ example: "HEADPHONES" })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9]+(?: [A-Z0-9]+)*$/, {
    message: "分类编码只能包含大写字母、数字和单个空格",
  })
  @MaxLength(100)
  classification?: string

  @ApiPropertyOptional({ description: "完整类目模糊筛选" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  category?: string

  @ApiPropertyOptional({ enum: PRODUCT_PUBLISH_TYPES })
  @IsOptional()
  @IsIn(PRODUCT_PUBLISH_TYPES as readonly string[])
  type?: (typeof PRODUCT_PUBLISH_TYPES)[number]
}

export class SpreadsheetUploadUrlDto {
  @ApiProperty({ example: "product-result.xlsx", description: "仅支持 xlsx/xlsm" })
  @IsString()
  @Matches(/\.(xlsx|xlsm)$/i, { message: "表格文件仅支持 xlsx 或 xlsm 格式" })
  filename: string
}

export class CompleteProductPublishTaskDto {
  @ApiProperty({ description: "表格预签名接口返回的 key" })
  @IsString()
  @MaxLength(1000)
  spreadsheetKey: string
}

export class SubmitProductPublishDto {
  @ApiProperty({
    example: "https://files.example.com/product-publish/listing.xlsx",
    description: "RPA 可公开下载的 Excel 文件 URL，仅支持 HTTPS",
  })
  @IsUrl({ protocols: ["https"], require_protocol: true })
  @Matches(/^https:\/\//i, { message: "上架文件 URL 必须使用 HTTPS" })
  @MaxLength(1000)
  fileUrl: string

  @ApiProperty({
    type: [String],
    example: ["SKU-001", "SKU-002"],
    description: "本次提交文件中的 SKU 列表；提交后冻结，查询 Amazon 处理结果时原样传给 RPA",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100_000)
  @IsString({ each: true })
  @Matches(/\S/, { each: true, message: "SKU 不能为空字符串" })
  @MaxLength(200, { each: true })
  skus: string[]
}

export class ProductPublishRpaCallbackDto {
  @ApiProperty({
    enum: ["1.0"],
    example: "1.0",
    description: "一键上架 RPA 回调协议版本，当前固定为 1.0",
  })
  @IsString()
  @Equals("1.0")
  contract_version: "1.0"

  @ApiPropertyOptional({
    example: "6b1ccdde-16f4-41e4-99d1-5d1ff273c02d",
    description: "可选的后端调度关联号；RPA 无法取得时无需传，后端会按业务键定位待处理请求",
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  request_id?: string

  @ApiProperty({
    example: true,
    description: "本次 RPA 业务处理是否成功；data/error 的组合由服务层校验",
  })
  @IsBoolean()
  ok: boolean

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "业务数据及定位字段。成功或失败都必须传；具体字段由 task_type 决定",
  })
  @IsObject()
  data: Record<string, unknown>

  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    description: "失败时的错误对象；与 ok/data 的组合由服务层校验",
  })
  @IsOptional()
  @IsObject()
  error?: Record<string, unknown>
}

export class WashImageLinksDto {
  @ApiProperty({ type: [String], description: "待洗链的原始图片 URL，最多 50 条" })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUrl({ protocols: ["http", "https"], require_protocol: true }, { each: true })
  imageUrls: string[]
}
