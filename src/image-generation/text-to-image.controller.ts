// src/image-generation/text-to-image.controller.ts
//
// 仅由 Next BFF 兼容层转发调用(带用户 Bearer)。响应体/状态码逐字段对齐
// Next 路由:POST → {jobId};错误 400 {error};GET 快照或 404 {error}。
// 用 @Res() 手写响应,绕过全局异常过滤器的包络重排。

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { TextToImageService, type TextToImageBody } from "./text-to-image.service";

@Controller("image-generation/text-to-image")
@UseGuards(JwtAuthGuard)
export class TextToImageController {
  constructor(private readonly t2i: TextToImageService) {}

  @Post()
  async create(
    @Body() body: TextToImageBody,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.t2i.create(body, (req.user as { id: number }).id);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ jobId: result.jobId });
  }

  @Get(":jobId")
  async get(
    @Param("jobId") jobId: string,
    @Res() res: Response,
  ): Promise<void> {
    const snapshot = await this.t2i.getSnapshot(jobId);
    if (!snapshot) {
      // 文案与源路由(GET /api/ai-creative/text-to-image/[jobId])逐字一致,
      // BFF 透传时字节等价。
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(snapshot);
  }
}
