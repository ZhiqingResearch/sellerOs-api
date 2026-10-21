/**
 * 收据附件通道一次性验证脚本：用 dev 环境真实 AK 走 MailProvider.sendMailWithAttachment
 * （阿里云 DirectMail singleSendMailAdvance）发一封带 PDF 附件的测试邮件。
 *
 * 用法：npx ts-node scripts/test-mail-attachment.ts <收件邮箱>
 * 依赖 .env 里的 ZQ_ACCESS_KEY_ID / ZQ_ACCESS_KEY_SECRET / MAIL_FROM（/ MAIL_FROM_ALIAS / MAIL_DM_ENDPOINT）。
 */
import { ConfigService } from "@nestjs/config"
import "dotenv/config"
import { MailProvider } from "../src/common/providers/mail.provider"

/** 造一个最小但合法的 PDF（正确计算 xref 偏移），内容一行英文测试文本 */
function buildTestPdf(): Buffer {
  const text = "SellerOS DirectMail attachment test - PDF OK"
  const content = `BT /F1 12 Tf 20 60 Td (${text}) Tj ET`
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 420 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${content.length + 1}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "binary"))
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefPos = Buffer.byteLength(pdf, "binary")
  const count = objects.length + 1
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`
  pdf += `trailer\n<</Size ${count}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`
  return Buffer.from(pdf, "binary")
}

async function main() {
  const to = process.argv[2]
  if (!to) {
    console.error("用法：npx ts-node scripts/test-mail-attachment.ts <收件邮箱>")
    process.exit(1)
  }
  for (const key of ["ZQ_ACCESS_KEY_ID", "ZQ_ACCESS_KEY_SECRET", "MAIL_FROM"]) {
    if (!process.env[key]) {
      console.error(`.env 缺少 ${key}，无法发送`)
      process.exit(1)
    }
  }
  console.log(
    `发信配置就绪：MAIL_FROM=${process.env.MAIL_FROM} endpoint=${process.env.MAIL_DM_ENDPOINT ?? "https://dm.aliyuncs.com"}`
  )

  const config = { get: (key: string) => process.env[key] } as ConfigService
  const mail = new MailProvider(config)
  const pdf = buildTestPdf()
  console.log(`附件 PDF ${pdf.length} 字节，发送到 ${to} ...`)

  await mail.sendMailWithAttachment(
    to,
    "【SellerOS】收据附件通道测试",
    `<p>这是一封验证 DirectMail 附件通道的测试邮件。</p><p>正常的话，本邮件应带有一个 <b>test-receipt.pdf</b> 附件（可打开，内容一行英文）。</p>`,
    [{ name: "test-receipt.pdf", content: pdf }]
  )
  console.log(
    "发送成功（SDK 未抛错）。请查收：主题「【SellerOS】收据附件通道测试」，应含 test-receipt.pdf 附件。"
  )
}

main().catch(e => {
  console.error("发送失败：", (e as Error).message)
  process.exit(1)
})
