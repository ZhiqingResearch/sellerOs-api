// src/image-generation/generate.controller.ts
//
// 主生图入口,由 Next BFF 兼容层转发调用(带用户 Bearer)。响应体/状态码逐
// 字段对齐源路由:
//   POST /api/image-generation/generate(multipart)→
//     {success:true, taskId:number, generatedImages:[{id,order,status:"GENERATING"}]}
//     错误 400 {error}(文案照源);建任务失败 502 {error}
//   POST /api/image-generation/tasks/:taskId/cancel → {success:true, aborted}
//     taskId 非法 400 {error: "Missing `taskId`"}(照源 cancel 文案)
// 用 @Res() 手写响应,绕过全局异常过滤器的包络重排。
//
// multipart 字段名与源路由 FormData 键一一对应:form(JSON 字符串文本字段,
// multer 解析后落在 req.body)+ main/mainImages/detail/structure/attachedRefs
// 文件字段(legacy 模式 main 必填;image-creation 模式 mainImages 多文件)。

import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  Res,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { InvalidMultipartFilter } from "./invalid-multipart.filter";
import {
  GenerateService,
  type GenerateUploadFiles,
} from "./generate.service";

@Controller("image-generation")
@UseGuards(JwtAuthGuard)
export class GenerateController {
  constructor(private readonly generate: GenerateService) {}

  @Post("generate")
  @UseFilters(InvalidMultipartFilter)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "main", maxCount: 1 },
        { name: "mainImages", maxCount: 30 },
        { name: "detail", maxCount: 1 },
        { name: "structure", maxCount: 1 },
        { name: "attachedRefs", maxCount: 30 },
      ],
      { limits: { fileSize: 50 * 1024 * 1024, files: 64 } },
    ),
  )
  async create(
    @UploadedFiles() files: GenerateUploadFiles,
    @Body("form") form: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.generate.create(
      { form, files },
      (req.user as { id: number }).id,
    );
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({
      success: true,
      taskId: result.taskId,
      generatedImages: result.generatedImages,
      ...(result.localRedraw ? { localRedraw: result.localRedraw } : {}),
    });
  }

  /** 服务端重试:重跑任务全部 FAILED 图(用落库 executionSpec,无需浏览器
   *  原始输入)。响应 {success, generatedImages:[{id,order,status}]} 对齐
   *  create;错误 400/404 {error}。 */
  @Post("tasks/:taskId/retry")
  async retry(
    @Param("taskId") taskId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = Number(taskId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      res.status(400).json({ error: "Missing `taskId`" });
      return;
    }
    const result = await this.generate.retryTaskImages(
      parsed,
      (req.user as { id: number }).id,
    );
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ success: true, generatedImages: result.generatedImages });
  }

  /** 取消在途任务:事务置 CANCELLED + 图 FAILED + abort 本进程执行,
   *  幂等;语义照源 /api/ai-creative/generate/cancel(响应 {success,aborted})。 */
  @Post("tasks/:taskId/cancel")
  async cancel(
    @Param("taskId") taskId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = Number(taskId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      res.status(400).json({ error: "Missing `taskId`" });
      return;
    }
    const result = await this.generate.cancel(
      parsed,
      (req.user as { id: number }).id,
    );
    res.json(result);
  }
}
