import { BadGatewayException, BadRequestException } from "@nestjs/common"
import axios from "axios"
import { SKILLS_KEY_ISSUE_TIMEOUT_MS, SkillsKeyProjectConfig } from "./skills-key-config.service"
import { SkillsKeyIssueError, SkillsKeyIssuerService } from "./skills-key-issuer.service"

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
    isAxiosError: (error: { isAxiosError?: boolean } | null) => error?.isAxiosError === true,
  },
}))

const phone = "13800000000"
const key = "zk-test-only-never-issued-user-credential"
const project: SkillsKeyProjectConfig = {
  code: "selleros",
  projectId: "test-project",
  apiOrigin: "https://skills.example.invalid",
  keyA: "test-only-project-credential",
}

describe("SkillsKeyIssuerService", () => {
  let post: jest.Mock
  let service: SkillsKeyIssuerService

  beforeEach(() => {
    post = jest.fn()
    ;(axios.create as jest.Mock).mockReturnValue({ post })
    service = new SkillsKeyIssuerService()
  })

  it.each([{ code: 0 }, { code: 200 }, { code: 201 }, { success: true }, { statusCode: 200 }])(
    "向固定 API 携带 KeyA 和可信手机号，校验成功包装 %p",
    marker => {
      post.mockResolvedValue({ status: 201, data: { ...marker, data: { phone, key } } })
      return expect(service.issue(project, phone)).resolves.toEqual({ phone, key })
    }
  )

  it("禁止重定向、设置请求总超时和响应大小上限，不附带 userId 或 operationId", async () => {
    post.mockResolvedValue({ status: 200, data: { code: 0, data: { phone, key } } })
    await service.issue(project, phone)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(
      "https://skills.example.invalid/api/v1/projects/keys",
      { phone },
      expect.objectContaining({
        headers: { "X-Project-Key": project.keyA, "Content-Type": "application/json" },
        timeout: SKILLS_KEY_ISSUE_TIMEOUT_MS,
        signal: expect.any(AbortSignal) as AbortSignal,
        maxRedirects: 0,
        maxContentLength: 16 * 1024,
        maxBodyLength: 2 * 1024,
      })
    )
  })

  it("兼容历史 sk_ 前缀", async () => {
    const historicalKey = "sk_test-only-historical-credential"
    post.mockResolvedValue({ status: 200, data: { code: 0, data: { phone, key: historicalKey } } })
    await expect(service.issue(project, phone)).resolves.toEqual({ phone, key: historicalKey })
  })

  it.each([
    { phone, key },
    { data: { phone, key } },
    { code: 400, data: { phone, key } },
    { code: 0, success: false, data: { phone, key } },
    { code: 0, statusCode: 500, data: { phone, key } },
    { code: "0", data: { phone, key } },
    { code: 0, data: { phone: "13900000000", key } },
    { code: 0, data: { phone, key: `${key}\n` } },
    { code: 0, data: { phone, key: "invalid-credential" } },
    { code: 0, data: { phone } },
    "invalid-json-response",
    null,
  ])("响应不可信时返回未知状态且不重试：%p", async data => {
    post.mockResolvedValue({ status: 200, data })
    await expect(service.issue(project, phone)).rejects.toMatchObject({
      failureCode: "ISSUE_RESPONSE_INVALID",
      upstreamStatus: 200,
    })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it.each([301, 400, 401, 404, 429, 500])("HTTP %i 不误报成功或重试", async status => {
    post.mockResolvedValue({ status, data: { code: 0, data: { phone, key } } })
    await expect(service.issue(project, phone)).rejects.toMatchObject({
      failureCode: "ISSUE_HTTP_ERROR",
      upstreamStatus: status,
    })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ISSUE_TLS_ERROR"],
    ["CERT_HAS_EXPIRED", "ISSUE_TLS_ERROR"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "ISSUE_TLS_ERROR"],
    ["ETIMEDOUT", "ISSUE_TIMEOUT"],
    ["ECONNABORTED", "ISSUE_TIMEOUT"],
    ["ERR_CANCELED", "ISSUE_TIMEOUT"],
    ["ENOTFOUND", "ISSUE_NETWORK_ERROR"],
    ["EAI_AGAIN", "ISSUE_NETWORK_ERROR"],
    ["ECONNRESET", "ISSUE_NETWORK_ERROR"],
    ["ECONNREFUSED", "ISSUE_NETWORK_ERROR"],
  ])("%s 仅保留安全故障分类，不携带原始异常或敏感信息", async (transportCode, failureCode) => {
    const axiosError = Object.assign(new Error(`timeout ${project.keyA} ${key} ${phone}`), {
      isAxiosError: true,
      code: transportCode,
      config: { headers: { "X-Project-Key": project.keyA }, data: { phone } },
      request: { secret: project.keyA },
      response: { data: { key } },
      cause: new Error(`${project.keyA} ${key} ${phone}`),
    })
    post.mockRejectedValue(axiosError)
    try {
      await service.issue(project, phone)
      throw new Error("应返回未知状态")
    } catch (error) {
      expect(error).toBeInstanceOf(BadGatewayException)
      expect(error).toBeInstanceOf(SkillsKeyIssueError)
      expect(error).toMatchObject({ failureCode, transportCode })
      expect(error).not.toBe(axiosError)
      const failure = error as BadGatewayException
      expect(failure.getResponse()).toEqual({
        code: "SKILLS_KEY_ISSUE_UNKNOWN",
        message: "接入密钥签发结果无法确认，请联系管理员恢复；请勿重复提交签发",
      })
      const details = JSON.stringify(error) + String(error)
      expect(details).not.toContain(project.keyA)
      expect(details).not.toContain(key)
      expect(details).not.toContain(phone)
      expect(error).not.toHaveProperty("cause")
      expect(error).not.toHaveProperty("request")
      expect(error).not.toHaveProperty("config")
    }
    expect(post).toHaveBeenCalledTimes(1)
  })

  it("Axios 404 响应按 HTTP 失败记录，不保存上游响应内容或未知 transport code", async () => {
    const secretDetails = `${project.keyA} ${key} ${phone}`
    const axiosError = Object.assign(new Error(secretDetails), {
      isAxiosError: true,
      code: secretDetails,
      response: { status: 404, data: { message: secretDetails } },
      config: { headers: { "X-Project-Key": project.keyA } },
    })
    post.mockRejectedValue(axiosError)
    const error: unknown = await service.issue(project, phone).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(SkillsKeyIssueError)
    expect(error).toMatchObject({ failureCode: "ISSUE_HTTP_ERROR", upstreamStatus: 404 })
    expect((error as SkillsKeyIssueError).transportCode).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain(secretDetails)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, 99, 600, 200.5, NaN, "404"])(
    "未知异常的无效上游状态 %p 不进入诊断字段",
    async status => {
      post.mockRejectedValue({
        isAxiosError: true,
        code: `${project.keyA} ${key} ${phone}`,
        response: { status },
      })
      await expect(service.issue(project, phone)).rejects.toMatchObject({
        failureCode: "ISSUE_RESULT_UNKNOWN",
        upstreamStatus: undefined,
        transportCode: undefined,
      })
      expect(post).toHaveBeenCalledTimes(1)
    }
  )

  it("非 Axios 的意外异常不假定含可信 HTTP 状态", async () => {
    post.mockRejectedValue({ response: { status: 404 }, message: key })
    await expect(service.issue(project, phone)).rejects.toMatchObject({
      failureCode: "ISSUE_RESULT_UNKNOWN",
      upstreamStatus: undefined,
    })
  })

  it("已解析响应缺少有效 HTTP 状态时拒绝接受 Key", async () => {
    post.mockResolvedValue({ data: { code: 0, data: { phone, key } } })
    await expect(service.issue(project, phone)).rejects.toMatchObject({
      failureCode: "ISSUE_RESPONSE_INVALID",
      upstreamStatus: undefined,
    })
  })

  it("安全异常构造入口再次过滤诊断值且公开响应不包含内部分类", () => {
    const failure = new SkillsKeyIssueError("ISSUE_RESULT_UNKNOWN", 999, project.keyA)
    expect(failure.upstreamStatus).toBeUndefined()
    expect(failure.transportCode).toBeUndefined()
    expect(failure.getResponse()).toEqual({
      code: "SKILLS_KEY_ISSUE_UNKNOWN",
      message: "接入密钥签发结果无法确认，请联系管理员恢复；请勿重复提交签发",
    })
  })

  it.each(["invalid", "13800000000\n", " 13800000000", "+8613800000000", "12800000000"])(
    "手机号不符合约定时在发出请求前失败：%p",
    async invalidPhone => {
      await expect(service.issue(project, invalidPhone)).rejects.toBeInstanceOf(BadRequestException)
      expect(post).not.toHaveBeenCalled()
    }
  )
})
