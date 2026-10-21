// src/image-generation/executor/spaces-transport.ts
//
// 把 core/storage.ts 的预签名 seam 接到本仓库的 SpacesService(服务身份,
// 不走 HTTP 自环、不需要用户 token)。模块初始化时通过
// setSpacesPresignTransport 注入;key 规则保持 `keyPrefix + uuid + ext`,
// 与原 /api/spaces/upload-url 端点的拼法一致。

import { randomUUID } from "node:crypto";
import { SpacesService } from "../../spaces/spaces.service";
import {
  extensionForMime,
  type GenerateUploadUrlRequest,
  type GenerateUploadUrlResponse,
  type SpacesPresignTransport,
} from "../core/storage";

export function spacesServiceTransport(
  spaces: SpacesService,
): SpacesPresignTransport {
  return {
    async generateUploadUrl(
      _authToken: string,
      body: GenerateUploadUrlRequest,
      _signal?: AbortSignal,
    ): Promise<GenerateUploadUrlResponse> {
      const ext = body.filename.includes(".")
        ? body.filename.slice(body.filename.lastIndexOf("."))
        : extensionForMime(body.contentType ?? "image/png");
      const key = `${body.keyPrefix ?? ""}${randomUUID()}${ext}`;
      const presigned = await spaces.generateUploadUrl({
        key,
        contentType: body.contentType,
        expiresIn: body.expiresIn,
      });
      return {
        uploadUrl: presigned.uploadUrl,
        publicUrl: presigned.publicUrl,
        headers: presigned.headers,
        key: presigned.key,
        expiresIn: presigned.expiresIn,
      };
    },
  };
}
