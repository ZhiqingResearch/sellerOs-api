import { ApiProperty } from "@nestjs/swagger"
import { IsNumber, Max, Min } from "class-validator"

export class UsdEstimateDto {
  @ApiProperty({ description: "人民币试算金额（元），仅用于展示，不创建订单或锁价", example: 399 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99999999.99)
  amountCny: number
}
