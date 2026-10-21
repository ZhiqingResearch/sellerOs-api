function requireTogether(config: Record<string, unknown>, names: string[]) {
  const configured = names.filter(name => {
    const value = config[name]
    return typeof value === "string" && value.trim().length > 0
  })
  if (configured.length === 0 || configured.length === names.length) return

  const missing = names.filter(name => !configured.includes(name))
  throw new Error(`环境变量必须成组配置，当前缺少：${missing.join(", ")}`)
}

function isConfigured(config: Record<string, unknown>, name: string): boolean {
  const value = config[name]
  return typeof value === "string" && value.trim().length > 0
}

function requireWhenEnabled(config: Record<string, unknown>, names: string[], integration: string) {
  const missing = names.filter(name => !isConfigured(config, name))
  if (missing.length > 0) {
    throw new Error(`启用${integration}前必须配置：${missing.join(", ")}`)
  }
}

const PRODUCT_PUBLISH_PROFILES = ["dev", "dev1", "uat", "prod"] as const

/**
 * 仅校验可选集成的成组配置：全部留空表示关闭，填写任意一项后必须补齐整组。
 * 这样本地测试不依赖第三方密钥，生产也不会以半配置状态启动。
 */
export function validateEnvironment(config: Record<string, unknown>) {
  requireTogether(config, ["AI_GATEWAY_API_KEY", "AI_GATEWAY_BASE_URL"])
  // SIF（竞品分析事实数据源）不做硬性要求：合并后 AI Gateway 同时服务视频/图片生成，
  // 视频-only 环境（如 UAT）没有 SIF 也必须能启动；竞品分析在未配置 SIF 时自身会报数据源错误。
  // （release 原版按「配置了 AI_GATEWAY_API_KEY 即要求 SIF」校验，仅适用于竞品单功能时期。）

  const aiGatewayDebugLogging = config.AI_GATEWAY_DEBUG_LOGGING
  const normalizedAiGatewayDebugLogging =
    typeof aiGatewayDebugLogging === "string" ? aiGatewayDebugLogging.trim().toLowerCase() : ""
  if (
    normalizedAiGatewayDebugLogging.length > 0 &&
    !["true", "false"].includes(normalizedAiGatewayDebugLogging)
  ) {
    throw new Error("AI_GATEWAY_DEBUG_LOGGING 只允许 true 或 false")
  }

  const feishuNames = ["FEISHU_APP_ID", "FEISHU_APP_SECRET"]
  requireTogether(config, feishuNames)
  const feishuEnabled = feishuNames.every(name => isConfigured(config, name))
  const productRpaNames = ["YINGDAO_PRODUCT_PUBLISH_TASK_UUID", "YINGDAO_PRODUCT_PUBLISH_APP_ID"]
  requireTogether(config, productRpaNames)

  const productRpaEnabled = productRpaNames.every(name => isConfigured(config, name))
  if (productRpaEnabled) {
    requireWhenEnabled(
      config,
      [
        "YINGDAO_ACCESS_KEY_ID",
        "YINGDAO_ACCESS_KEY_SECRET",
        "YINGDAO_PRODUCT_PUBLISH_PROFILE",
        "YINGDAO_PRODUCT_PUBLISH_CALLBACK_API_KEY",
      ],
      "一键上架影刀任务"
    )
  }
  if (feishuEnabled) {
    requireWhenEnabled(config, ["YINGDAO_PRODUCT_PUBLISH_PROFILE"], "一键上架飞书店铺同步")
  }

  const productPublishProfile = config.YINGDAO_PRODUCT_PUBLISH_PROFILE
  const normalizedProductPublishProfile =
    typeof productPublishProfile === "string" ? productPublishProfile.trim() : ""
  if (
    isConfigured(config, "YINGDAO_PRODUCT_PUBLISH_PROFILE") &&
    !PRODUCT_PUBLISH_PROFILES.some(profile => profile === normalizedProductPublishProfile)
  ) {
    throw new Error("YINGDAO_PRODUCT_PUBLISH_PROFILE 只允许 dev、dev1、uat、prod")
  }

  for (const name of [
    "YINGDAO_PRODUCT_PUBLISH_RUN_TIMEOUT_SECONDS",
    "YINGDAO_PRODUCT_PUBLISH_MAX_POLL_ATTEMPTS",
    "YINGDAO_PRODUCT_PUBLISH_CALLBACK_TIMEOUT_SECONDS",
  ]) {
    const value = config[name]
    const normalized = typeof value === "string" ? value.trim() : ""
    if (
      normalized.length > 0 &&
      (!/^\d+$/.test(normalized) ||
        !Number.isSafeInteger(Number(normalized)) ||
        Number(normalized) <= 0)
    ) {
      throw new Error(`${name} 必须为正整数`)
    }
  }

  if (productRpaEnabled) {
    const runTimeout = Number(config.YINGDAO_PRODUCT_PUBLISH_RUN_TIMEOUT_SECONDS || "3600")
    const callbackTimeout = Number(
      config.YINGDAO_PRODUCT_PUBLISH_CALLBACK_TIMEOUT_SECONDS || "4200"
    )
    if (callbackTimeout < runTimeout + 60) {
      throw new Error(
        "YINGDAO_PRODUCT_PUBLISH_CALLBACK_TIMEOUT_SECONDS 必须至少比 YINGDAO_PRODUCT_PUBLISH_RUN_TIMEOUT_SECONDS 多 60 秒"
      )
    }
  }

  return config
}
