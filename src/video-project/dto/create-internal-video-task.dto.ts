import { ApiProperty } from "@nestjs/swagger"
import {
  IsNotEmpty,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator"
import type { InternalCreateVideoTaskInput } from "../internal-generation.service"

@ValidatorConstraint({ name: "internalVideoRequest" })
class InternalVideoRequestConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const request = value as Record<string, unknown>
    return [request.model, request.prompt].every(
      value => typeof value === "string" && value.trim().length > 0
    )
  }

  defaultMessage(): string {
    return "request.model 和 request.prompt 必须是非空字符串"
  }
}

export class CreateInternalVideoTaskDto implements InternalCreateVideoTaskInput {
  @ApiProperty({ description: "源平台用户手机号" })
  @IsString()
  @IsNotEmpty()
  phone: string

  @ApiProperty({ description: "模型业务分类，与模型目录 category 一致", example: "REFERENCE" })
  @IsString()
  @Matches(/\S/, { message: "必须指定视频模型业务分类" })
  @MaxLength(50)
  category: string

  @ApiProperty({ description: "完整网关视频生成参数，包含 model 和 prompt", type: Object })
  @IsObject()
  @Validate(InternalVideoRequestConstraint)
  request: InternalCreateVideoTaskInput["request"]
}
