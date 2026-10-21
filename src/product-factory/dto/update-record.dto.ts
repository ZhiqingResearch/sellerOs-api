import { ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from "class-validator"

export class UpdateRecordDto {
  @ApiPropertyOptional({
    example: "竞品复刻 · B0C1X2Y3Z4（便携榨汁杯 400ml）",
    description: "记录名称",
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  productName?: string

  @ApiPropertyOptional({
    example: "in_progress",
    description: "状态",
    enum: ["draft", "in_progress", "completed"],
  })
  @IsOptional()
  @IsIn(["draft", "in_progress", "completed"])
  status?: string

  @ApiPropertyOptional({
    example: 3,
    description: "当前步骤（1 ~ totalSteps，上限由服务端按已存记录校验）",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  currentStep?: number

  @ApiPropertyOptional({
    example: {
      brandNameEn: "BlendGo",
      primaryColors: ["#000000"],
      designStyles: ["minimal"],
      logoUrl: "",
    },
    description: "品牌基因快照/覆盖",
  })
  @IsOptional()
  @IsObject()
  brandIdentity?: Record<string, unknown>

  @ApiPropertyOptional({ description: "第 1 步数据（DeconstructResult，整体替换）" })
  @IsOptional()
  @IsObject()
  step1Data?: Record<string, unknown>

  @ApiPropertyOptional({ description: "第 2 步数据（AnalysisResult，整体替换）" })
  @IsOptional()
  @IsObject()
  step2Data?: Record<string, unknown>

  @ApiPropertyOptional({ description: "第 3 步数据（{ listingResult, scoreResult }，整体替换）" })
  @IsOptional()
  @IsObject()
  step3Data?: Record<string, unknown>

  @ApiPropertyOptional({ description: "第 4 步数据（ImageStepData，整体替换）" })
  @IsOptional()
  @IsObject()
  step4Data?: Record<string, unknown>

  @ApiPropertyOptional({ description: "第 5 步数据（AplusStepData，整体替换）" })
  @IsOptional()
  @IsObject()
  step5Data?: Record<string, unknown>

  @ApiPropertyOptional({ description: "第 6 步数据（SopResult，整体替换）" })
  @IsOptional()
  @IsObject()
  step6Data?: Record<string, unknown>
}
