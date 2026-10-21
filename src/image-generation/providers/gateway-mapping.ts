// src/image-generation/providers/gateway-mapping.ts
//
// 逻辑 provider ID → AI Gateway model 的映射。B4(2026-09-10)direct 通道
// 退役后,这是本模块唯一的 provider 解析路径:
//   - 已知逻辑 ID → 映射表内的网关 model;
//   - 退役槽位(atlas-wan / tokenlab-gpt-image / chadgpt-ru,网关无对应)
//     → null,入口 400「Unsupported provider」;
//   - 其余任意字符串 → 目录直传的网关 model id,原样透传(网关侧校验)。
//
// 事实来源:2026-09-01 dev 网关目录拉取(docs/references/
// ai-gateway-image-models-2026-09-01.txt,前端仓库);计费倍率统一取
// AiGatewayModel.priceMultiplier(执行器 loadPriceMultiplier)。

/** 有网关对应的逻辑 ID → 网关 model。 */
export const GATEWAY_MODEL_BY_LOGICAL_ID: Record<string, string> = {
  "gemini-nano-banana": "ZQ-Image-1",
  "apifox-zq2-pro-plus": "ZQ-Image-2",
  "atlas-gpt": "ZQ-Image-2-Backup",
  "openai-gpt-image": "ZQ-Image-2-Backup",
  "atlas-seedream": "ZQ-Image-3",
  "atlas-seedream-pro": "ZQ-Image-Ultra",
};

/** B4 退役的 direct 槽位:网关无对应模型,显式 400 而非透传网关报错
 *  (网关的 no-route 会被误译成「不支持此比例/清晰度」,误导用户)。 */
const RETIRED_LOGICAL_IDS = new Set([
  "atlas-wan",
  "tokenlab-gpt-image",
  "chadgpt-ru",
]);

/**
 * 解析 provider 标识(逻辑 ID 或目录直传的网关 model id)到网关 model。
 * 返回 null = 已退役槽位,调用方应 400 拒绝。
 */
export function resolveGatewayModel(providerId: string): string | null {
  if (providerId in GATEWAY_MODEL_BY_LOGICAL_ID) {
    return GATEWAY_MODEL_BY_LOGICAL_ID[providerId];
  }
  if (RETIRED_LOGICAL_IDS.has(providerId)) {
    return null;
  }
  // 非已知逻辑 ID —— 目录直传的网关 model id,原样透传(由网关侧校验)。
  return providerId;
}
