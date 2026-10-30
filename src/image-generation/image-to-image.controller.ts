// src/image-generation/image-to-image.controller.ts
//
// 仅由 Next BFF 兼容层转发调用(带用户 Bearer)。响应体/状态码逐字段对齐
// 源路由:POST multipart → {jobId, taskId, traceId, total, items};错误
// 400 {error};GET 快照或 404 {error: "Job not found"}。
// 用 @Res() 手写响应,绕过全局异常过滤器的包络重排。
//
// multipart 字段名与源路由 FormData 键一一对应:form(JSON 字符串文本字段,
// multer 解析后落在 req.body)+ main/character/style/scene/refs/references
// 文件字段。refs 上限放宽到 30,让 >10 的 references 能进 handler,由
// service 按源路由文案拒绝(批量上限 400)。

import {
  Body,
  Controller,
  Get,
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
  ImageToImageService,
  type I2IUploadFiles,
} from "./image-to-image.service";

@Controller("image-generation/image-to-image")
@UseGuards(JwtAuthGuard)
export class ImageToImageController {
  constructor(private readonly i2i: ImageToImageService) {}

  @Post()
  @UseFilters(InvalidMultipartFilter)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "main", maxCount: 1 },
        { name: "character", maxCount: 1 },
        { name: "style", maxCount: 1 },
        { name: "scene", maxCount: 1 },
        { name: "refs", maxCount: 30 },
        { name: "references", maxCount: 30 },
      ],
      { limits: { fileSize: 50 * 1024 * 1024, files: 40 } },
    ),
  )
  async create(
    @UploadedFiles() files: I2IUploadFiles,
    @Body("form") form: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.i2i.create(
      { form, files },
      (req.user as { id: number }).id,
    );
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({
      jobId: result.jobId,
      taskId: result.taskId,
      traceId: result.traceId,
      total: result.total,
      items: result.items,
      ...(result.localRedraw ? { localRedraw: result.localRedraw } : {}),
    });
  }

  @Get(":jobId")
  async get(
    @Param("jobId") jobId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const snapshot = await this.i2i.getSnapshot(
      jobId,
      (req.user as { id: number }).id,
    );
    if (!snapshot) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(snapshot);
  }
}
