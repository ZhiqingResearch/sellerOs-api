import { OmitType, PartialType } from "@nestjs/swagger"
import { CreateHistoryDto } from "./create-history.dto"

/**
 * 编辑历史记录：title / score / data 均可选，type 不可改。
 * 只有 data 发生变化时才会留档新版本（见 HistoryService.update）。
 */
export class UpdateHistoryDto extends PartialType(OmitType(CreateHistoryDto, ["type"] as const)) {}
