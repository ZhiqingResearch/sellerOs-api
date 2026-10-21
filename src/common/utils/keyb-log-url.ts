/** KeyB 相关接口只记固定路由，避免误把凭证放进 query 时落日志。 */
export function isKeybSensitiveUrl(url: string): boolean {
  return /^\/(?:api\/)?(?:skills\/keys|open\/keyb\/credit)(?:[/?]|$)/i.test(url)
}

export function keybSafeLogUrl(url: string): string {
  if (!isKeybSensitiveUrl(url)) return url
  const match =
    /^(\/(?:api\/)?(?:skills\/keys|open\/keyb\/credit))(?:\/(reset|reveal|deduct))?(?=[/?]|$)/i.exec(
      url
    )
  return match ? match[0] : "/[密钥接口]"
}
