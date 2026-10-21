import { validateEnvironment } from "./env.validation"

describe("validateEnvironment", () => {
  it("允许可选集成全部留空", () => {
    expect(validateEnvironment({})).toEqual({})
  })

  it("AI Gateway Key 和 Base URL 必须同时配置", () => {
    expect(() => validateEnvironment({ AI_GATEWAY_API_KEY: "sk_test" })).toThrow(
      "AI_GATEWAY_BASE_URL"
    )
    expect(
      validateEnvironment({
        AI_GATEWAY_API_KEY: "sk_test",
        AI_GATEWAY_BASE_URL: "https://gateway.example.com/v1",
      })
    ).toBeDefined()
  })

  it("飞书配置只填写一部分时拒绝启动", () => {
    expect(() => validateEnvironment({ FEISHU_APP_ID: "cli_xxx" })).toThrow("FEISHU_APP_SECRET")
  })

  it("飞书应用凭证完整时通过，表格标识可使用代码默认值", () => {
    const config = {
      FEISHU_APP_ID: "cli_xxx",
      FEISHU_APP_SECRET: "secret",
      YINGDAO_PRODUCT_PUBLISH_PROFILE: "prod",
    }
    expect(validateEnvironment(config)).toBe(config)
  })

  it("启用飞书店铺同步时必须配置环境 profile", () => {
    expect(() =>
      validateEnvironment({ FEISHU_APP_ID: "cli_xxx", FEISHU_APP_SECRET: "secret" })
    ).toThrow("YINGDAO_PRODUCT_PUBLISH_PROFILE")
  })

  it("一键上架影刀任务与应用 ID 必须同时配置", () => {
    expect(() => validateEnvironment({ YINGDAO_PRODUCT_PUBLISH_TASK_UUID: "task" })).toThrow(
      "YINGDAO_PRODUCT_PUBLISH_APP_ID"
    )
  })

  it("启用一键上架影刀任务时必须提供影刀鉴权和独立回调密钥", () => {
    expect(() =>
      validateEnvironment({
        YINGDAO_PRODUCT_PUBLISH_TASK_UUID: "task",
        YINGDAO_PRODUCT_PUBLISH_APP_ID: "app",
      })
    ).toThrow("YINGDAO_ACCESS_KEY_ID")

    expect(() =>
      validateEnvironment({
        YINGDAO_PRODUCT_PUBLISH_TASK_UUID: "task",
        YINGDAO_PRODUCT_PUBLISH_APP_ID: "app",
        YINGDAO_ACCESS_KEY_ID: "key",
        YINGDAO_ACCESS_KEY_SECRET: "secret",
        YINGDAO_PRODUCT_PUBLISH_PROFILE: "uat",
      })
    ).toThrow("YINGDAO_PRODUCT_PUBLISH_CALLBACK_API_KEY")

    const config = {
      YINGDAO_PRODUCT_PUBLISH_TASK_UUID: "task",
      YINGDAO_PRODUCT_PUBLISH_APP_ID: "app",
      YINGDAO_ACCESS_KEY_ID: "key",
      YINGDAO_ACCESS_KEY_SECRET: "secret",
      YINGDAO_PRODUCT_PUBLISH_PROFILE: "uat",
      YINGDAO_PRODUCT_PUBLISH_CALLBACK_API_KEY: "callback-secret",
    }
    expect(validateEnvironment(config)).toBe(config)
  })

  it("启用一键上架影刀任务时不要求 API_BASE_URL", () => {
    const config = {
      YINGDAO_PRODUCT_PUBLISH_TASK_UUID: "task",
      YINGDAO_PRODUCT_PUBLISH_APP_ID: "app",
      YINGDAO_ACCESS_KEY_ID: "key",
      YINGDAO_ACCESS_KEY_SECRET: "secret",
      YINGDAO_PRODUCT_PUBLISH_PROFILE: "prod",
      YINGDAO_PRODUCT_PUBLISH_CALLBACK_API_KEY: "callback-secret",
    }
    expect(validateEnvironment(config)).toBe(config)
  })

  it("允许配置一键上架影刀参数名和正整数运行超时", () => {
    const config = {
      YINGDAO_PRODUCT_PUBLISH_PARAM_NAME: "paramsFile",
      YINGDAO_PRODUCT_PUBLISH_RUN_TIMEOUT_SECONDS: "3600",
      YINGDAO_PRODUCT_PUBLISH_MAX_POLL_ATTEMPTS: "288",
      YINGDAO_PRODUCT_PUBLISH_CALLBACK_TIMEOUT_SECONDS: "4200",
    }
    expect(validateEnvironment(config)).toBe(config)
  })

  it("启用一键上架影刀任务时必须配置合法 profile", () => {
    const base = {
      YINGDAO_PRODUCT_PUBLISH_TASK_UUID: "task",
      YINGDAO_PRODUCT_PUBLISH_APP_ID: "app",
      YINGDAO_ACCESS_KEY_ID: "key",
      YINGDAO_ACCESS_KEY_SECRET: "secret",
      YINGDAO_PRODUCT_PUBLISH_CALLBACK_API_KEY: "callback-secret",
    }
    expect(() => validateEnvironment(base)).toThrow("YINGDAO_PRODUCT_PUBLISH_PROFILE")
    expect(() =>
      validateEnvironment({ ...base, YINGDAO_PRODUCT_PUBLISH_PROFILE: "staging" })
    ).toThrow("只允许 dev、dev1、uat、prod")

    for (const profile of ["dev", "dev1", "uat", "prod"]) {
      const config = { ...base, YINGDAO_PRODUCT_PUBLISH_PROFILE: profile }
      expect(validateEnvironment(config)).toBe(config)
    }
  })

  it("拒绝非正整数的一键上架影刀运行超时", () => {
    expect(() => validateEnvironment({ YINGDAO_PRODUCT_PUBLISH_RUN_TIMEOUT_SECONDS: "0" })).toThrow(
      "YINGDAO_PRODUCT_PUBLISH_RUN_TIMEOUT_SECONDS"
    )
    expect(() =>
      validateEnvironment({ YINGDAO_PRODUCT_PUBLISH_RUN_TIMEOUT_SECONDS: "1.5" })
    ).toThrow("必须为正整数")
    expect(() => validateEnvironment({ YINGDAO_PRODUCT_PUBLISH_MAX_POLL_ATTEMPTS: "-1" })).toThrow(
      "YINGDAO_PRODUCT_PUBLISH_MAX_POLL_ATTEMPTS"
    )
    expect(() =>
      validateEnvironment({ YINGDAO_PRODUCT_PUBLISH_CALLBACK_TIMEOUT_SECONDS: "0" })
    ).toThrow("YINGDAO_PRODUCT_PUBLISH_CALLBACK_TIMEOUT_SECONDS")
    expect(() =>
      validateEnvironment({ YINGDAO_PRODUCT_PUBLISH_CALLBACK_TIMEOUT_SECONDS: "9".repeat(400) })
    ).toThrow("必须为正整数")
  })

  it("回调超时必须覆盖影刀运行超时并预留缓冲", () => {
    expect(() =>
      validateEnvironment({
        YINGDAO_PRODUCT_PUBLISH_TASK_UUID: "task",
        YINGDAO_PRODUCT_PUBLISH_APP_ID: "app",
        YINGDAO_ACCESS_KEY_ID: "key",
        YINGDAO_ACCESS_KEY_SECRET: "secret",
        YINGDAO_PRODUCT_PUBLISH_PROFILE: "prod",
        YINGDAO_PRODUCT_PUBLISH_CALLBACK_API_KEY: "callback-secret",
        YINGDAO_PRODUCT_PUBLISH_RUN_TIMEOUT_SECONDS: "3600",
        YINGDAO_PRODUCT_PUBLISH_CALLBACK_TIMEOUT_SECONDS: "3600",
      })
    ).toThrow("必须至少比")
  })
})
