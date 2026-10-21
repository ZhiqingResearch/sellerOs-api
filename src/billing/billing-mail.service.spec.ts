import { ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import { MailProvider } from "../common/providers/mail.provider"
import { BillingMailService } from "./billing-mail.service"

/** jest.Mock 的 calls 为 any；提取第 n 次调用实参并显式收窄类型后断言 */
const callArgs = <T extends unknown[]>(mock: jest.Mock, call: number): T => {
  const calls = mock.mock.calls as unknown[][]
  return calls[call] as T
}

describe("BillingMailService", () => {
  let service: BillingMailService
  let mail: { sendMail: jest.Mock; sendMailWithAttachment: jest.Mock }

  const OPTS = {
    to: "u@x.com",
    subject: "【SellerOS】充值收据 SR1",
    html: "<p>receipt</p>",
    pdfBuffer: Buffer.from("%PDF-1.4 fake"),
    pdfFilename: "receipt-SR1.pdf",
  }

  beforeEach(async () => {
    mail = {
      sendMail: jest.fn().mockResolvedValue(undefined),
      sendMailWithAttachment: jest.fn().mockResolvedValue(undefined),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        BillingMailService,
        { provide: MailProvider, useValue: mail },
        { provide: ConfigService, useValue: { get: () => "ops@x.com" } },
      ],
    }).compile()
    service = moduleRef.get(BillingMailService)
  })

  it("有 PDF → 走附件发送，withAttachment=true，不触碰纯 HTML 通道", async () => {
    const res = await service.sendReceiptMail(OPTS)
    expect(res).toEqual({ channel: "directmail", withAttachment: true })
    const [to, subject, html, attachments] = callArgs<
      [string, string, string, { name: string; content: Buffer }[]]
    >(mail.sendMailWithAttachment, 0)
    expect([to, subject, html]).toEqual([OPTS.to, OPTS.subject, OPTS.html])
    expect(attachments).toHaveLength(1)
    expect(attachments[0].name).toBe("receipt-SR1.pdf")
    expect(attachments[0].content.equals(OPTS.pdfBuffer)).toBe(true)
    expect(mail.sendMail).not.toHaveBeenCalled()
  })

  it("附件发送失败 → 自动降级纯 HTML，withAttachment=false", async () => {
    mail.sendMailWithAttachment.mockRejectedValue(new Error("oss upload failed"))
    const res = await service.sendReceiptMail(OPTS)
    expect(res).toEqual({ channel: "directmail", withAttachment: false })
    expect(mail.sendMail).toHaveBeenCalledTimes(1)
    const [to, subject, html] = callArgs<[string, string, string]>(mail.sendMail, 0)
    expect([to, subject, html]).toEqual([OPTS.to, OPTS.subject, OPTS.html])
  })

  it("pdfBuffer=null → 直接纯 HTML，不尝试附件", async () => {
    const res = await service.sendReceiptMail({ ...OPTS, pdfBuffer: null })
    expect(res).toEqual({ channel: "directmail", withAttachment: false })
    expect(mail.sendMailWithAttachment).not.toHaveBeenCalled()
    expect(mail.sendMail).toHaveBeenCalledTimes(1)
  })

  it("sendAlert：逐收件人发送，单个失败不影响其它", async () => {
    mail.sendMail.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined)
    const multi = await Test.createTestingModule({
      providers: [
        BillingMailService,
        { provide: MailProvider, useValue: mail },
        { provide: ConfigService, useValue: { get: () => "a@x.com, b@x.com" } },
      ],
    }).compile()
    const svc = multi.get(BillingMailService)
    await svc.sendAlert("金额不符", "<p>alert</p>")
    expect(mail.sendMail).toHaveBeenCalledTimes(2)
  })

  it("sendAlert：未配置 BILLING_ALERT_EMAIL 时只告警不发送", async () => {
    const mod = await Test.createTestingModule({
      providers: [
        BillingMailService,
        { provide: MailProvider, useValue: mail },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile()
    const svc = mod.get(BillingMailService)
    await svc.sendAlert("金额不符", "<p>alert</p>")
    expect(mail.sendMail).not.toHaveBeenCalled()
  })
})
