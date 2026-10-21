import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

/**
 * 卖家精灵 MCP 客户端（取证 C 卡用，asin_competitor 按目标 ASIN 查同款竞品）。
 * Streamable HTTP + secret-key 头、10s 连接超时、ERROR_UNAUTHORIZED/连接异常重连重试一次、工具名兼容匹配。
 * 曾用 keyword 版 competitor_lookup——关键词宽匹配 + 按销量排序会被配件/耗材霸榜
 * （如 HP 笔记本查出打印纸），已废弃；与 competitor-analysis 的 MCP 客户端并存（后者自建实例，不动）。
 * 不做 MCP 计费记录（estimatedPoints 仅估值，第三方成本口径待产品方案）。
 */

@Injectable()
export class SellerSpriteMcpClient {
  private readonly logger = new Logger(SellerSpriteMcpClient.name)
  private clientPromise: Promise<Client> | null = null
  private toolsCache: Awaited<ReturnType<Client["listTools"]>>["tools"] | null = null

  constructor(private readonly config: ConfigService) {}

  private getClient(): Promise<Client> {
    if (this.clientPromise) return this.clientPromise

    this.clientPromise = (async () => {
      const secretKey = this.config.get<string>("SELLERSPRITE_SECRET_KEY")
      if (!secretKey) throw new Error("SELLERSPRITE_SECRET_KEY not configured")

      const transport = new StreamableHTTPClientTransport(
        new URL(
          this.config.get<string>("SELLERSPRITE_MCP_URL") ?? "https://mcp.sellersprite.com/mcp"
        ),
        {
          requestInit: {
            headers: { "secret-key": secretKey },
          },
        }
      )

      const client = new Client({ name: "amazon-agent", version: "1.0.0" })
      try {
        // 10s 连接超时
        await Promise.race([
          client.connect(transport),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("MCP connection timeout (10s)")), 10000)
          ),
        ])
        return client
      } catch (e) {
        this.clientPromise = null
        throw e
      }
    })()

    return this.clientPromise
  }

  private async listTools() {
    if (this.toolsCache) return this.toolsCache
    const client = await this.getClient()
    const result = await client.listTools()
    this.toolsCache = result.tools
    return result.tools
  }

  private async callTool(name: string, args: Record<string, unknown>) {
    this.logger.log(`[MCP:call] tool=${name}`)
    const t0 = Date.now()
    let result
    try {
      const client = await this.getClient()
      result = await client.callTool({ name, arguments: args })

      const text = (Array.isArray(result.content) ? result.content : [])
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("")
      if (text.includes("ERROR_UNAUTHORIZED")) {
        this.logger.warn(`[MCP] ${name}: unauthorized, reconnecting...`)
        this.clientPromise = null
        this.toolsCache = null
        const freshClient = await this.getClient()
        result = await freshClient.callTool({ name, arguments: args })
      }
    } catch (e) {
      this.logger.warn(`[MCP] ${name}: connection error, reconnecting... ${(e as Error).message}`)
      this.clientPromise = null
      this.toolsCache = null
      const freshClient = await this.getClient()
      result = await freshClient.callTool({ name, arguments: args })
    }
    this.logger.log(`[MCP:result] tool=${name} elapsed=${Date.now() - t0}ms`)
    return result
  }

  private async resolveAsinCompetitorToolName(): Promise<string> {
    const tools = await this.listTools()
    const exact = tools.find(t => t.name === "asin_competitor")
    if (exact) return exact.name
    const fuzzy = tools.find(t => t.name.toLowerCase().includes("competitor"))
    if (fuzzy) return fuzzy.name
    throw new Error(
      `SellerSprite MCP: missing asin competitor tool (e.g. asin_competitor). Got: ${tools.map(t => t.name).join(", ") || "(none)"}`
    )
  }

  private parseMcpToolJsonResult(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
    const text = (Array.isArray(result.content) ? result.content : [])
      .filter(
        (c): c is { type: "text"; text: string } =>
          typeof c === "object" &&
          c !== null &&
          (c as { type?: string }).type === "text" &&
          typeof (c as { text?: string }).text === "string"
      )
      .map(c => c.text)
      .join("")
    if (!text.trim()) return null
    return JSON.parse(text) as unknown
  }

  /**
   * 调用 MCP「ASIN 竞品查询」，参数顶层平铺（schema 根级 marketplace/asin/size，无 request 包装）。
   * 响应 data 直接是竞品数组（兼容 items 包装），元素含 asin/title/brand/nodeLabelPath 等。
   */
  async callAsinCompetitor(
    asin: string,
    marketplace: string,
    size = 10
  ): Promise<{ items: Record<string, unknown>[]; parsed: unknown }> {
    const toolName = await this.resolveAsinCompetitorToolName()
    const result = await this.callTool(toolName, { marketplace, asin, size })
    const parsed = this.parseMcpToolJsonResult(result)
    const root =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    const data = root?.data
    const rawItems = Array.isArray(data)
      ? data
      : data != null &&
          typeof data === "object" &&
          Array.isArray((data as Record<string, unknown>).items)
        ? ((data as Record<string, unknown>).items as unknown[])
        : []
    const items = rawItems.filter(
      (x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)
    )
    return { items, parsed }
  }
}
