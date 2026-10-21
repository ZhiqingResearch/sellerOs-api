import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto"

export type AllinpayFields = Record<string, string>
export const ALLINPAY_PAY_TYPES = { WECHAT: "W01", ALIPAY: "A01", CARD: "U01" } as const
export const ALLINPAY_TRX_CODES = { WECHAT: "VSP501", ALIPAY: "VSP511", CARD: "VSP551" } as const

/** 签名用原值排序拼接；不能先 URL encode，也不能丢弃新增的回调字段。 */
export function allinpaySignContent(fields: AllinpayFields): string {
  return Object.keys(fields)
    .filter(key => key !== "sign" && fields[key] !== "")
    .sort()
    .map(key => `${key}=${fields[key]}`)
    .join("&")
}

@Injectable()
export class AllinpayProvider implements OnModuleInit {
  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    if (this.config.get<string>("ALLINPAY_ENABLED") === "true") this.assertConfigured()
  }

  assertConfigured(isNewPayment = true) {
    if (isNewPayment && this.config.get<string>("ALLINPAY_ENABLED") !== "true") {
      throw new ServiceUnavailableException("国内支付暂未开放，请选择海外支付")
    }
    for (const key of [
      "CUSID",
      "APPID",
      "PRIVATE_KEY",
      "PUBLIC_KEY",
      "API_ORIGIN",
      "NOTIFY_URL",
      "PAYEE",
    ]) {
      if (!this.config.get<string>(`ALLINPAY_${key}`)) throw new Error(`缺少 ALLINPAY_${key} 配置`)
    }
    const origin = new URL(this.config.get<string>("ALLINPAY_API_ORIGIN")!)
    const notify = new URL(this.config.get<string>("ALLINPAY_NOTIFY_URL")!)
    if (
      origin.protocol !== "https:" ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password ||
      notify.protocol !== "https:" ||
      notify.search ||
      notify.hash ||
      notify.port ||
      notify.username ||
      notify.password
    ) {
      throw new Error("通联接口须使用 HTTPS，回调地址不得含参数或非默认端口")
    }
    createPrivateKey(this._key("PRIVATE_KEY"))
    createPublicKey(this._key("PUBLIC_KEY"))
  }

  verifyFields(payload: unknown): AllinpayFields {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new BadRequestException("通联响应格式错误")
    const fields: AllinpayFields = {}
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value !== "string") throw new BadRequestException("通联字段必须为字符串")
      fields[key] = value
    }
    let isValid = false
    try {
      isValid =
        !!fields.sign &&
        verify(
          "RSA-SHA1",
          Buffer.from(allinpaySignContent(fields), "utf8"),
          this._key("PUBLIC_KEY"),
          Buffer.from(fields.sign, "base64")
        )
    } catch {
      /* 无效签名统一拒绝，不输出载荷或密钥 */
    }
    if (!isValid) throw new BadRequestException("通联签名验证失败")
    if (
      fields.cusid !== this.config.get<string>("ALLINPAY_CUSID") ||
      fields.appid !== this.config.get<string>("ALLINPAY_APPID")
    ) {
      throw new BadRequestException("通联商户信息不匹配")
    }
    return fields
  }

  pay(orderNo: string, amountFen: number, paytype: string) {
    this.assertConfigured()
    return this._request("/apiweb/unitorder/pay", {
      reqsn: orderNo,
      trxamt: String(amountFen),
      paytype,
      validtime: "15",
      body: "SellerOS在线购买",
      notify_url: this.config.get<string>("ALLINPAY_NOTIFY_URL")!,
    })
  }

  query(orderNo: string, trxid?: string | null) {
    return this._request("/apiweb/tranx/query", trxid ? { trxid } : { reqsn: orderNo })
  }

  close(orderNo: string, trxid?: string | null) {
    return this._request("/apiweb/tranx/close", {
      version: "12",
      ...(trxid ? { oldtrxid: trxid } : { oldreqsn: orderNo }),
    })
  }

  private _key(name: "PRIVATE_KEY" | "PUBLIC_KEY"): string {
    return (this.config.get<string>(`ALLINPAY_${name}`) ?? "").replace(/\\n/g, "\n")
  }

  private async _request(path: string, params: AllinpayFields): Promise<AllinpayFields> {
    // 关闭新支付入口后，保留密钥仍可为存量订单查单、关单。
    this.assertConfigured(false)
    const fields: AllinpayFields = {
      cusid: this.config.get<string>("ALLINPAY_CUSID")!,
      appid: this.config.get<string>("ALLINPAY_APPID")!,
      version: "11",
      signtype: "RSA",
      randomstr: randomBytes(16).toString("hex"),
      ...params,
    }
    fields.sign = sign(
      "RSA-SHA1",
      Buffer.from(allinpaySignContent(fields), "utf8"),
      this._key("PRIVATE_KEY")
    ).toString("base64")
    let payload: unknown
    try {
      const response = await fetch(new URL(path, this.config.get<string>("ALLINPAY_API_ORIGIN")), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams(fields).toString(),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      })
      if (!response.ok) throw new Error("http_error")
      payload = await response.json()
    } catch {
      throw new BadGatewayException("通联支付结果确认中，请查询原订单，勿重复付款")
    }
    // FAIL 可能没有签名，绝不能据此关闭订单或重新收费；只报通信异常等待查单。
    if (
      !payload ||
      typeof payload !== "object" ||
      (payload as Record<string, unknown>).retcode !== "SUCCESS"
    ) {
      throw new BadGatewayException("通联暂未确认请求，请稍后查询原订单")
    }
    return this.verifyFields(payload)
  }
}
