// src/image-generation/providers/provider-factory.token.ts
//
// Provider 工厂注入点。B4(2026-09-10)后只有网关一条通道:生产由模块
// makeProviderFactory 构造(注入 AiGatewayProvider,按 gateway-mapping
// 解析);测试用自定义 provider 覆盖 token,不触网。

import type { ImageProvider } from "../core/types";

export const IMAGE_PROVIDER_FACTORY = Symbol("IMAGE_PROVIDER_FACTORY");
export type ImageProviderFactory = (id: string) => ImageProvider;
