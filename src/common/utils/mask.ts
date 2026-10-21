/** 手机号脱敏（列表/详情默认；全号仅 GET /users/:id/phone 且写审计） */
export function maskPhone(phone: string): string {
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : "****"
}
