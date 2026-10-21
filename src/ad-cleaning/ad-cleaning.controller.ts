import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common"
import { FileInterceptor } from "@nestjs/platform-express"
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger"
import type { Response } from "express"
import { extname } from "path"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { AD_CLEANING_MAX_FILE_SIZE, AD_CLEANING_TEMP_DIR } from "./ad-cleaning.constants"
import { AdCleaningService, type UploadedAdSpreadsheet } from "./ad-cleaning.service"
import { AdCleaningTaskResponseDto } from "./dto/ad-cleaning-task-response.dto"
import { QueryAdCleaningTasksDto } from "./dto/query-ad-cleaning-tasks.dto"

interface AuthedRequest {
  user: { id: number }
}

@ApiTags("广告数据清洗")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("ad-cleaning")
export class AdCleaningController {
  constructor(private readonly service: AdCleaningService) {}

  @Post("tasks")
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor("file", {
      dest: AD_CLEANING_TEMP_DIR,
      limits: { fileSize: AD_CLEANING_MAX_FILE_SIZE, files: 1 },
      fileFilter: (_req, file, callback) => {
        if (extname(file.originalname).toLowerCase() !== ".xlsx") {
          callback(new BadRequestException("第一版仅支持 .xlsx 文件"), false)
          return
        }
        callback(null, true)
      },
    })
  )
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: {
        file: {
          type: "string",
          format: "binary",
          description: "Amazon Sponsored Products 搜索词报告，最大 50 MB / 5 万行",
        },
      },
    },
  })
  @ApiOperation({
    summary: "上传广告搜索词报告并创建清洗任务",
    description:
      "创建 MySQL 任务后立即返回任务 ID；后端单 Worker 串行清洗。前端轮询状态接口，成功后可获得文件 URL 和每个 Sheet 的前100行预览。",
  })
  @ApiAcceptedResponse({ description: "清洗任务已创建", type: AdCleaningTaskResponseDto })
  createTask(
    @UploadedFile() file: UploadedAdSpreadsheet | undefined,
    @Request() req: AuthedRequest
  ) {
    return this.service.createTask(file, req.user.id)
  }

  @Get("tasks")
  @ApiOperation({
    summary: "分页查询当前用户的清洗任务",
    description: "按创建时间倒序；列表为轻量口径，不含 stats/sheetPreviews，详情走单个任务接口。",
  })
  listTasks(@Request() req: AuthedRequest, @Query() query: QueryAdCleaningTasksDto) {
    return this.service.listTasks(req.user.id, query)
  }

  @Get("tasks/:taskId")
  @ApiOperation({ summary: "查询广告清洗任务状态" })
  @ApiOkResponse({
    description: "任务状态、进度、统计或失败原因",
    type: AdCleaningTaskResponseDto,
  })
  getTask(@Param("taskId") taskId: string, @Request() req: AuthedRequest) {
    return this.service.getTask(taskId, req.user.id)
  }

  @Get("tasks/:taskId/download")
  @ApiOperation({ summary: "下载清洗结果 Excel" })
  @ApiResponse({ status: HttpStatus.FOUND, description: "重定向到文件服务器中的清洗结果" })
  async download(
    @Param("taskId") taskId: string,
    @Request() req: AuthedRequest,
    @Res() response: Response
  ): Promise<void> {
    const resultFileUrl = await this.service.getResultUrl(taskId, req.user.id)
    response.redirect(HttpStatus.FOUND, resultFileUrl)
  }
}
