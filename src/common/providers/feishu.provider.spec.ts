/* eslint-disable @typescript-eslint/unbound-method */
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import { FeishuProvider } from "./feishu.provider"

jest.mock("axios")

const mockedAxios = jest.mocked(axios)

const COMPLETE_CONFIG: Record<string, string> = {
  FEISHU_APP_ID: "cli_test",
  FEISHU_APP_SECRET: "app-secret",
  FEISHU_BITABLE_APP_TOKEN: "bascn_test",
  FEISHU_BITABLE_TABLE_ID: "tbl_test",
  FEISHU_BITABLE_VIEW_ID: "vew_test",
  FEISHU_BASE_URL: "https://feishu.example.com/",
}

function createProvider(values: Record<string, string> = COMPLETE_CONFIG): FeishuProvider {
  const config = {
    get: jest.fn((key: string) => values[key]),
  }
  return new FeishuProvider(config as unknown as ConfigService)
}

function tokenResponse(token = "tenant-token") {
  return {
    data: {
      code: 0,
      msg: "success",
      tenant_access_token: token,
      expire: 7200,
    },
  }
}

function recordsResponse(
  items: unknown[],
  options: { hasMore?: boolean; pageToken?: string } = {}
) {
  return {
    data: {
      code: 0,
      msg: "success",
      data: {
        items,
        has_more: options.hasMore ?? false,
        page_token: options.pageToken,
      },
    },
  }
}

describe("FeishuProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("isConfigured", () => {
    it("所有必要配置存在时返回 true", () => {
      expect(createProvider().isConfigured()).toBe(true)
    })

    it("任一应用凭证缺失时返回 false", () => {
      expect(
        createProvider({
          ...COMPLETE_CONFIG,
          FEISHU_APP_SECRET: "",
        }).isConfigured()
      ).toBe(false)
    })

    it("未显式配置表格标识时使用需求指定的视图", () => {
      expect(
        createProvider({
          FEISHU_APP_ID: "cli_test",
          FEISHU_APP_SECRET: "app-secret",
        }).isConfigured()
      ).toBe(true)
    })
  })

  it("未配置时返回中文错误且不发请求", async () => {
    const provider = createProvider({})

    await expect(provider.searchStoreRecords()).rejects.toThrow(
      "飞书多维表格配置不完整，请检查应用凭证和表格配置"
    )
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it("按指定视图和字段分页读取记录", async () => {
    const provider = createProvider()
    mockedAxios.post
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        recordsResponse(
          [
            {
              record_id: "rec_1",
              fields: { 店铺ID: "27826971599669", 紫鸟店铺: "测试店铺" },
              last_modified_time: "1720000000000",
            },
          ],
          { hasMore: true, pageToken: "next-page" }
        )
      )
      .mockResolvedValueOnce(
        recordsResponse([
          {
            record_id: "rec_2",
            fields: { 店铺ID: "27826971599670" },
            last_modified_time: 1720000001000,
          },
        ])
      )

    await expect(provider.searchStoreRecords()).resolves.toEqual([
      {
        recordId: "rec_1",
        fields: { 店铺ID: "27826971599669", 紫鸟店铺: "测试店铺" },
        lastModifiedTime: 1720000000000,
      },
      {
        recordId: "rec_2",
        fields: { 店铺ID: "27826971599670" },
        lastModifiedTime: 1720000001000,
      },
    ])

    expect(mockedAxios.post).toHaveBeenNthCalledWith(
      1,
      "https://feishu.example.com/open-apis/auth/v3/tenant_access_token/internal",
      { app_id: "cli_test", app_secret: "app-secret" },
      expect.objectContaining({ timeout: 30_000 })
    )
    expect(mockedAxios.post).toHaveBeenNthCalledWith(
      2,
      "https://feishu.example.com/open-apis/bitable/v1/apps/bascn_test/tables/tbl_test/records/search",
      {
        view_id: "vew_test",
        field_names: [
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
        ],
        automatic_fields: true,
      },
      expect.anything()
    )
    const firstSearchConfig: unknown = mockedAxios.post.mock.calls[1]?.[2]
    expect(firstSearchConfig).toEqual({
      params: { page_size: 500 },
      headers: {
        Authorization: "Bearer tenant-token",
        "Content-Type": "application/json; charset=utf-8",
      },
      timeout: 30_000,
    })
    expect(mockedAxios.post).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("/records/search"),
      expect.anything(),
      expect.objectContaining({
        params: {
          page_size: 500,
          page_token: "next-page",
        },
      })
    )
  })

  it("在 token 有效期内复用缓存", async () => {
    const provider = createProvider()
    mockedAxios.post
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(recordsResponse([]))
      .mockResolvedValueOnce(recordsResponse([]))

    await provider.searchStoreRecords()
    await provider.searchStoreRecords()

    const tokenCalls = mockedAxios.post.mock.calls.filter(call =>
      String(call[0]).includes("tenant_access_token/internal")
    )
    expect(tokenCalls).toHaveLength(1)
  })

  it("记录请求返回 401 时强制刷新 token 并重试一次", async () => {
    const provider = createProvider()
    mockedAxios.post
      .mockResolvedValueOnce(tokenResponse("expired-token"))
      .mockRejectedValueOnce({ response: { status: 401, data: { msg: "token expired" } } })
      .mockResolvedValueOnce(tokenResponse("fresh-token"))
      .mockResolvedValueOnce(recordsResponse([{ record_id: "rec_1", fields: { 店铺ID: "1" } }]))

    await expect(provider.searchStoreRecords()).resolves.toEqual([
      { recordId: "rec_1", fields: { 店铺ID: "1" } },
    ])

    expect(mockedAxios.post).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("/records/search"),
      expect.anything(),
      expect.anything()
    )
    const retriedSearchConfig: unknown = mockedAxios.post.mock.calls[3]?.[2]
    expect(retriedSearchConfig).toEqual(
      expect.objectContaining({
        headers: {
          Authorization: "Bearer fresh-token",
          "Content-Type": "application/json; charset=utf-8",
        },
      })
    )
  })

  it("非 401 请求错误不重试并返回中文错误", async () => {
    const provider = createProvider()
    mockedAxios.post
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce({ response: { status: 500, data: { msg: "upstream error" } } })

    await expect(provider.searchStoreRecords()).rejects.toThrow(
      "读取飞书店铺数据失败：upstream error"
    )
    expect(mockedAxios.post).toHaveBeenCalledTimes(2)
  })

  it("飞书业务响应失败时返回中文上下文", async () => {
    const provider = createProvider()
    mockedAxios.post.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce({
      data: { code: 1254001, msg: "WrongRequestBody" },
    })

    await expect(provider.searchStoreRecords()).rejects.toThrow(
      "读取飞书店铺数据失败：飞书多维表格查询失败：WrongRequestBody"
    )
  })

  it("鉴权失败时不暴露凭证并返回中文上下文", async () => {
    const provider = createProvider()
    mockedAxios.post.mockResolvedValueOnce({
      data: { code: 10003, msg: "凭证无效" },
    })

    await expect(provider.searchStoreRecords()).rejects.toThrow(
      "读取飞书店铺数据失败：飞书鉴权失败：凭证无效"
    )
    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
  })
})
