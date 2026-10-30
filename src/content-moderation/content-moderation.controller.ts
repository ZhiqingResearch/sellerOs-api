import {
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Request,
  Res,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from "@nestjs/swagger"
import { IsIn, IsString, Matches } from "class-validator"
import type { Response } from "express"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import {
  inputHash,
  MODERATION_TASKS,
  moderationSnapshot,
  TaskModerationService,
  type ModerationBusinessType,
} from "./task-moderation.service"

class CheckBusinessContentDto {
  @ApiProperty({ enum: Object.keys(MODERATION_TASKS) })
  @IsIn(Object.keys(MODERATION_TASKS))
  businessType: ModerationBusinessType

  @ApiProperty({ example: "123" })
  @IsString()
  @Matches(/^[1-9]\d*$/)
  businessTaskId: string
}

@ApiTags("内容安全审核")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("content-moderation")
export class ContentModerationController {
  constructor(private readonly tasks: TaskModerationService) {}

  @Post("check")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "核对本人业务任务审核，通过后自动继续业务" })
  async check(
    @Body() dto: CheckBusinessContentDto,
    @Request() req: { user: { id: number } },
    @Res({ passthrough: true }) res: Response
  ) {
    const result = await this.snapshot(dto.businessType, dto.businessTaskId, req.user.id, true)
    res.status(["PENDING", "PROCESSING"].includes(result.moderationStatus || "") ? 202 : 200)
    return result
  }

  @Get("tasks/:businessType/:businessTaskId")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "主动查询审核结果并尝试继续业务" })
  get(@Param() dto: CheckBusinessContentDto, @Request() req: { user: { id: number } }) {
    return this.snapshot(dto.businessType, dto.businessTaskId, req.user.id)
  }

  private async snapshot(
    type: ModerationBusinessType,
    taskId: string,
    userId: number,
    requireActive = false
  ) {
    const key = await this.tasks.ownedKey(type, taskId, userId)
    const row = await this.tasks.refresh(key, true, requireActive)
    if (requireActive && row.status === "CANCELLED")
      throw new ConflictException("任务已取消，不能重新发起审核")
    return {
      businessType: type,
      businessTaskId: taskId,
      ...moderationSnapshot(row),
      canProceed:
        row.moderationStatus === "PASSED" &&
        (row.moderation as { inputHash?: string } | null)?.inputHash ===
          inputHash(row.generationParams) &&
        ["WAITING_MODERATION", "GENERATING"].includes(row.status),
    }
  }
}
