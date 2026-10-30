// src/image-generation/executor/host-image.ts
//
// 自 amazon-agent text-to-image route 的 hostImage 原样移植:
// data URL → 字节直传;外链 → 服务端拉取转存;自有 Spaces URL → 保留。
// 服务身份 transport 已接线,authToken 形参保留只为兼容 core 签名。

import {
  base64ToBytes,
  uploadBytesToSpaces,
  uploadRemoteUrlToSpaces,
} from "../core/storage";

export async function hostImage(url: string, authToken = "", labelId?: string): Promise<string> {
  if (url.startsWith("data:")) {
    const mime = url.split(";")[0].split(":")[1] || "image/png";
    const base64Data = url.split(",")[1] ?? "";
    return uploadBytesToSpaces({
      bytes: base64ToBytes(base64Data),
      mimeType: mime,
      scene: "IMAGE_CREATION_OUTPUT",
      authToken,
      labelId,
    });
  }
  return uploadRemoteUrlToSpaces({
      url,
      scene: "IMAGE_CREATION_OUTPUT",
      authToken,
      labelId,
    });
}
