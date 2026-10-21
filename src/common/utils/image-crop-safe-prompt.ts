const COMMON_RATIOS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"])

function normalizeRatio(value: string | null | undefined): string | null {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)[:x](\d+(?:\.\d+)?)$/i)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return `${width}:${height}`
  let left = width
  let right = height
  while (right) [left, right] = [right, left % right]
  return `${width / left}:${height / left}`
}

/** 常用比例不主动缩小主体；自定义比例及提交侧比例改写需要预留裁剪空间。 */
export function centerCropSafeRatio(
  target: string | null | undefined,
  applied?: string | null,
  custom = false
): string | null {
  const ratio = normalizeRatio(target)
  if (!ratio) return null
  const appliedRatio = normalizeRatio(applied)
  const [width, height] = ratio.split(":").map(Number)
  const [appliedWidth, appliedHeight] = (appliedRatio ?? ratio).split(":").map(Number)
  const changed = Math.abs(appliedWidth / appliedHeight - width / height) / (width / height) >= 0.01
  return custom || !COMMON_RATIOS.has(ratio) || changed ? ratio : null
}

export function buildCenterCropDirective(targetRatio: string): string {
  return `中心裁剪安全构图：
最终交付目标为宽高比 ${targetRatio}。
若生成图片与目标比例不一致，后续将以画面中心为锚点，保留尽可能大的 ${targetRatio} 矩形区域。
请将本次要求呈现的主体、人物及所有重要视觉信息（如文字、图标、小元素等）集中在该中央安全区域内，并与安全区域边界保持距离。
适当拉远镜头、缩小主体，四周保留充足的可裁剪背景。完整商品图必须保留商品全部外轮廓；细节特写则完整保留指定细节，不必改成全商品图。
预计被裁掉的区域只能安排背景，不放置商品、人物、文字或其他重要信息。不得将关键信息放在画面边缘。
本段仅用于构图控制，不改变原有的图上文字内容、语言或无文字要求。不要将本段说明、安全框或裁剪线绘制到图中。`
}
