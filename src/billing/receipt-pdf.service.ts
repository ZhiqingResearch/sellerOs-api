import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import type { Browser } from "puppeteer-core"

/**
 * 收据 PDF 生成：puppeteer-core + Chromium Headless Shell（HTML→PDF，邮件附件用；前端下载 PDF 由前端自己渲染）。
 * 环境变量：PUPPETEER_EXECUTABLE_PATH（如 /usr/bin/chromium-headless-shell）。
 * 未配置时抛 503——调用方降级（邮件只发 HTML 正文并告警），不阻塞记账。
 * Docker 镜像需安装 chromium-headless-shell（见 Dockerfile runtime 阶段）。
 * 注：puppeteer-core 为纯 ESM 包，只能动态 import（静态引入会让 Jest/CJS 场景直接崩）；
 * Node 22 运行时原生支持 require(esm)，生产无碍。
 */
@Injectable()
export class ReceiptPdfService {
  private readonly logger = new Logger(ReceiptPdfService.name)
  private readonly executablePath: string | null

  constructor(config: ConfigService) {
    this.executablePath = config.get<string>("PUPPETEER_EXECUTABLE_PATH") || null
    if (!this.executablePath) {
      this.logger.warn(
        "PUPPETEER_EXECUTABLE_PATH 未配置，收据 PDF 生成不可用（将降级为无附件邮件）"
      )
    }
  }

  get available(): boolean {
    return !!this.executablePath
  }

  /** HTML → PDF Buffer（每次独立启停浏览器；收据低频，先求稳） */
  async renderPdf(html: string): Promise<Buffer> {
    if (!this.executablePath) throw new ServiceUnavailableException("PDF 生成未配置")
    const { default: puppeteer } = await import("puppeteer-core")
    let browser: Browser | null = null
    try {
      browser = await puppeteer.launch({
        executablePath: this.executablePath,
        headless: "shell",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      })
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: "load" })
      const pdf = await page.pdf({ format: "A4", printBackground: true })
      return Buffer.from(pdf)
    } finally {
      if (browser) await browser.close().catch(() => undefined)
    }
  }
}
