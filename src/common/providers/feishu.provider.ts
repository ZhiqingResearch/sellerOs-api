import { Injectable } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"

const DEFAULT_BASE_URL = "https://open.feishu.cn"
const DEFAULT_BITABLE_APP_TOKEN = "F8a8bVmq0aTfgVshLkBc5fxQnOd"
const DEFAULT_BITABLE_TABLE_ID = "tblDhqrTSPiS003m"
const DEFAULT_BITABLE_VIEW_ID = "vewkPm0nDO"
const REQUEST_TIMEOUT_MS = 30_000
const PAGE_SIZE = 500
const TOKEN_REFRESH_BUFFER_MS = 60_000

const STORE_FIELD_NAMES = [
  "UUID",
  "公司",
  "平台",
  "店铺类型",
  "账号类型",
  "紫鸟店铺",
  "店铺简称",
  "子店铺",
  "站点",
  "备注",
  "店铺ID",
  "是否禁用",
] as const

export interface FeishuBitableRecord {
  recordId: string
  fields: Record<string, unknown>
  lastModifiedTime?: number
}

interface FeishuSearchPage {
  items: FeishuBitableRecord[]
  hasMore: boolean
  pageToken?: string
}

interface CachedToken {
  value: string
  expiresAt: number
}

@Injectable()
export class FeishuProvider {
  private readonly appId: string
  private readonly appSecret: string
  private readonly appToken: string
  private readonly tableId: string
  private readonly viewId: string
  private readonly baseUrl: string
  private cachedToken?: CachedToken

  constructor(private readonly config: ConfigService) {
    this.appId = this.readConfig("FEISHU_APP_ID")
    this.appSecret = this.readConfig("FEISHU_APP_SECRET")
    this.appToken = this.readConfig("FEISHU_BITABLE_APP_TOKEN") || DEFAULT_BITABLE_APP_TOKEN
    this.tableId = this.readConfig("FEISHU_BITABLE_TABLE_ID") || DEFAULT_BITABLE_TABLE_ID
    this.viewId = this.readConfig("FEISHU_BITABLE_VIEW_ID") || DEFAULT_BITABLE_VIEW_ID
    this.baseUrl = (this.readConfig("FEISHU_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "")
  }

  isConfigured(): boolean {
    return Boolean(
      this.appId && this.appSecret && this.appToken && this.tableId && this.viewId && this.baseUrl
    )
  }

  /** 分页读取配置视图中的全部店铺记录。 */
  async searchStoreRecords(): Promise<FeishuBitableRecord[]> {
    if (!this.isConfigured()) {
      throw new Error("飞书多维表格配置不完整，请检查应用凭证和表格配置")
    }

    try {
      const records: FeishuBitableRecord[] = []
      const visitedPageTokens = new Set<string>()
      let pageToken: string | undefined

      do {
        const page = await this.searchPage(pageToken)
        records.push(...page.items)

        if (!page.hasMore) break
        if (!page.pageToken || visitedPageTokens.has(page.pageToken)) {
          throw new Error("飞书多维表格分页响应无效")
        }

        visitedPageTokens.add(page.pageToken)
        pageToken = page.pageToken
      } while (pageToken)

      return records
    } catch (error: unknown) {
      throw new Error(`读取飞书店铺数据失败：${this.extractErrorMessage(error)}`)
    }
  }

  private async searchPage(pageToken?: string): Promise<FeishuSearchPage> {
    const token = await this.getTenantAccessToken()

    try {
      const response = await this.requestSearchPage(token, pageToken)
      return this.parseSearchPage(response.data)
    } catch (error: unknown) {
      if (this.getHttpStatus(error) !== 401) throw error

      const refreshedToken = await this.getTenantAccessToken(true)
      const response = await this.requestSearchPage(refreshedToken, pageToken)
      return this.parseSearchPage(response.data)
    }
  }

  private requestSearchPage(token: string, pageToken?: string) {
    const params: Record<string, string | number | boolean> = {
      page_size: PAGE_SIZE,
    }
    if (pageToken) params.page_token = pageToken

    return axios.post<unknown>(
      `${this.baseUrl}/open-apis/bitable/v1/apps/${encodeURIComponent(this.appToken)}/tables/${encodeURIComponent(this.tableId)}/records/search`,
      {
        view_id: this.viewId,
        field_names: [...STORE_FIELD_NAMES],
        automatic_fields: true,
      },
      {
        params,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    )
  }

  private async getTenantAccessToken(forceRefresh = false): Promise<string> {
    if (
      !forceRefresh &&
      this.cachedToken &&
      Date.now() < this.cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS
    ) {
      return this.cachedToken.value
    }

    const response = await axios.post<unknown>(
      `${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        app_id: this.appId,
        app_secret: this.appSecret,
      },
      {
        headers: { "Content-Type": "application/json; charset=utf-8" },
        timeout: REQUEST_TIMEOUT_MS,
      }
    )
    const data = this.requireObject(response.data, "飞书鉴权响应格式错误")

    if (typeof data.code !== "number") {
      throw new Error("飞书鉴权响应格式错误")
    }
    if (data.code !== 0) {
      throw new Error(`飞书鉴权失败：${this.responseMessage(data) || `错误码 ${data.code}`}`)
    }
    if (
      typeof data.tenant_access_token !== "string" ||
      !data.tenant_access_token ||
      typeof data.expire !== "number" ||
      !Number.isFinite(data.expire) ||
      data.expire <= 0
    ) {
      throw new Error("飞书鉴权响应格式错误")
    }

    this.cachedToken = {
      value: data.tenant_access_token,
      expiresAt: Date.now() + data.expire * 1000,
    }
    return data.tenant_access_token
  }

  private parseSearchPage(value: unknown): FeishuSearchPage {
    const response = this.requireObject(value, "飞书多维表格响应格式错误")
    if (typeof response.code !== "number") {
      throw new Error("飞书多维表格响应格式错误")
    }
    if (response.code !== 0) {
      throw new Error(
        `飞书多维表格查询失败：${this.responseMessage(response) || `错误码 ${response.code}`}`
      )
    }

    const data = this.requireObject(response.data, "飞书多维表格响应格式错误")
    if (!Array.isArray(data.items)) {
      throw new Error("飞书多维表格响应格式错误")
    }
    if (data.has_more !== undefined && typeof data.has_more !== "boolean") {
      throw new Error("飞书多维表格响应格式错误")
    }

    const hasMore = data.has_more === true
    const pageToken = typeof data.page_token === "string" ? data.page_token : undefined
    if (hasMore && !pageToken) {
      throw new Error("飞书多维表格分页响应缺少 page_token")
    }

    return {
      items: data.items.map(item => this.parseRecord(item)),
      hasMore,
      pageToken,
    }
  }

  private parseRecord(value: unknown): FeishuBitableRecord {
    const record = this.requireObject(value, "飞书多维表格记录格式错误")
    if (typeof record.record_id !== "string" || !record.record_id) {
      throw new Error("飞书多维表格记录缺少 record_id")
    }
    if (!this.isObject(record.fields)) {
      throw new Error(`飞书多维表格记录 ${record.record_id} 的 fields 格式错误`)
    }

    const result: FeishuBitableRecord = {
      recordId: record.record_id,
      fields: record.fields,
    }
    const lastModifiedTime = this.parseTimestamp(record.last_modified_time)
    if (lastModifiedTime !== undefined) result.lastModifiedTime = lastModifiedTime
    return result
  }

  private parseTimestamp(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
    return undefined
  }

  private readConfig(key: string): string {
    const value = this.config.get<string>(key)
    return typeof value === "string" ? value.trim() : ""
  }

  private requireObject(value: unknown, message: string): Record<string, unknown> {
    if (!this.isObject(value)) throw new Error(message)
    return value
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  private responseMessage(response: Record<string, unknown>): string | undefined {
    return typeof response.msg === "string" && response.msg ? response.msg : undefined
  }

  private getHttpStatus(error: unknown): number | undefined {
    if (!this.isObject(error) || !this.isObject(error.response)) return undefined
    return typeof error.response.status === "number" ? error.response.status : undefined
  }

  private extractErrorMessage(error: unknown): string {
    if (this.isObject(error) && this.isObject(error.response)) {
      const responseData = error.response.data
      if (this.isObject(responseData)) {
        const message = this.responseMessage(responseData)
        if (message) return message
      }
    }
    return error instanceof Error ? error.message : String(error)
  }
}
