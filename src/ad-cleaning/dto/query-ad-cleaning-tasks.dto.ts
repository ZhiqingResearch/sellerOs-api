import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsEnum, IsOptional } from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

export class QueryAdCleaningTasksDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: ["PENDING", "PROCESSING", "SUCCESS", "FAILED"],
    description: "按任务状态筛选，缺省=全部",
  })
  @IsOptional()
  @IsEnum(["PENDING", "PROCESSING", "SUCCESS", "FAILED"])
  status?: "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED"
}
