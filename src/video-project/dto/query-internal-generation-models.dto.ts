import { PartialType } from "@nestjs/swagger"
import { QueryAiGatewayModelsDto } from "../../ai-gateway/dto/ai-gateway-model.dto"

/** 内部目录允许跨分类查询；保留已提供字段的校验和运行时元数据。 */
export class QueryInternalGenerationModelsDto extends PartialType(QueryAiGatewayModelsDto) {}
