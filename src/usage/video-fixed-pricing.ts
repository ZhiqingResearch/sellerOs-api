import { Decimal } from "@prisma/client/runtime/library"

import { UsageService } from "./usage.service"

/**
 * 视频固定一口价（积分/秒 × 分辨率档）的预检金额计算，供各提交入口共用：
 * 配了该 (publicId, category, resolution) 档 → perSec × duration 秒（不打折口径，
 * 与终态固定价扣费同源）；时长 0/缺失（自动时长档）按 1 秒保底计。
 * 未配置/缺档 → null（调用方回落网关估价 × 倍率预检）。
 */
export async function fixedVideoRequestCredits(
  usage: UsageService,
  publicId: string,
  category: string,
  request: {
    resolution?: string | null
    duration_seconds?: number | null
    mode?: string | null
  }
): Promise<Decimal | null> {
  const tier = await usage.resolveFixedVideoTier(
    publicId,
    category,
    request.resolution,
    request.mode
  )
  if (!tier) return null
  // 自适应保留档（flat）为按次一口价，不乘时长；其余档 积分/秒 × 时长（0/缺失按 1 秒保底）
  const duration = tier.flat ? 1 : Math.max(request.duration_seconds ?? 0, 1)
  return tier.creditsPerSec.mul(duration)
}

/** 批量预检求和：任一为 null（该笔回落按量）则整批返回 null，保持预检口径统一 */
export function sumFixedVideoCredits(amounts: (Decimal | null)[]): Decimal | null {
  let total: Decimal | null = new Decimal(0)
  for (const amount of amounts) {
    if (!amount) return null
    total = total.plus(amount)
  }
  return total
}
