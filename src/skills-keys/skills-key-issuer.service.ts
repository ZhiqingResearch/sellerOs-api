import { BadGatewayException, BadRequestException, Injectable } from "@nestjs/common"
import axios, { AxiosInstance } from "axios"
import { SKILLS_KEY_ISSUE_TIMEOUT_MS, SkillsKeyProjectConfig } from "./skills-key-config.service"
import { isValidKeyB } from "./skills-key-crypto.service"

export interface IssuedSkillsKey {
  phone: string
  key: string
}

export type SkillsKeyIssueFailureCode =
  | "ISSUE_TLS_ERROR"
  | "ISSUE_TIMEOUT"
  | "ISSUE_NETWORK_ERROR"
  | "ISSUE_HTTP_ERROR"
  | "ISSUE_RESPONSE_INVALID"
  | "ISSUE_RESULT_UNKNOWN"

const TLS_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_SIGNATURE_FAILURE",
  "CERT_REVOKED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
])
const TIMEOUT_ERROR_CODES = new Set(["ETIMEDOUT", "ECONNABORTED", "ERR_CANCELED"])
const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_NETWORK",
])

function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined
}

function safeTransportCode(value: unknown): string | undefined {
  return typeof value === "string" &&
    (TLS_ERROR_CODES.has(value) || TIMEOUT_ERROR_CODES.has(value) || NETWORK_ERROR_CODES.has(value))
    ? value
    : undefined
}

/** 只保留可审计的枚举信息，绝不引用原始 Axios 错误及其中的凭证。 */
export class SkillsKeyIssueError extends BadGatewayException {
  readonly upstreamStatus?: number
  readonly transportCode?: string

  constructor(
    readonly failureCode: SkillsKeyIssueFailureCode,
    upstreamStatus?: number,
    transportCode?: string
  ) {
    super({
      code: "SKILLS_KEY_ISSUE_UNKNOWN",
      message: "接入密钥签发结果无法确认，请联系管理员恢复；请勿重复提交签发",
    })
    this.upstreamStatus = safeStatus(upstreamStatus)
    this.transportCode = safeTransportCode(transportCode)
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function classifyIssueError(error: unknown): SkillsKeyIssueError {
  const transportCode = safeTransportCode(objectValue(error)?.code)
  const upstreamStatus = axios.isAxiosError(error) ? safeStatus(error.response?.status) : undefined
  if (transportCode && TLS_ERROR_CODES.has(transportCode)) {
    return new SkillsKeyIssueError("ISSUE_TLS_ERROR", upstreamStatus, transportCode)
  }
  if (transportCode && TIMEOUT_ERROR_CODES.has(transportCode)) {
    return new SkillsKeyIssueError("ISSUE_TIMEOUT", upstreamStatus, transportCode)
  }
  if (transportCode && NETWORK_ERROR_CODES.has(transportCode)) {
    return new SkillsKeyIssueError("ISSUE_NETWORK_ERROR", upstreamStatus, transportCode)
  }
  return new SkillsKeyIssueError(
    upstreamStatus === undefined ? "ISSUE_RESULT_UNKNOWN" : "ISSUE_HTTP_ERROR",
    upstreamStatus
  )
}

/** API 签发会轮换旧 Key，因此这里绝不自动重试，也不把未知结果当作未执行。 */
@Injectable()
export class SkillsKeyIssuerService {
  private readonly http: AxiosInstance

  constructor() {
    this.http = axios.create()
  }

  async issue(project: SkillsKeyProjectConfig, phone: string): Promise<IssuedSkillsKey> {
    if (typeof phone !== "string" || phone.length !== 11 || !/^1[3-9]\d{9}$/.test(phone)) {
      throw new BadRequestException({
        code: "SKILLS_PHONE_INVALID",
        message: "当前账号手机号格式不符合接入要求，请联系管理员",
      })
    }
    try {
      const response = await this.http.post<unknown>(
        `${project.apiOrigin}/api/v1/projects/keys`,
        { phone },
        {
          headers: { "X-Project-Key": project.keyA, "Content-Type": "application/json" },
          timeout: SKILLS_KEY_ISSUE_TIMEOUT_MS,
          signal: AbortSignal.timeout(SKILLS_KEY_ISSUE_TIMEOUT_MS),
          maxRedirects: 0,
          maxContentLength: 16 * 1024,
          maxBodyLength: 2 * 1024,
          responseType: "json",
        }
      )
      const upstreamStatus = safeStatus(response.status)
      if (upstreamStatus === undefined) throw new SkillsKeyIssueError("ISSUE_RESPONSE_INVALID")
      if (upstreamStatus < 200 || upstreamStatus >= 300) {
        throw new SkillsKeyIssueError("ISSUE_HTTP_ERROR", upstreamStatus)
      }
      const wrapper = objectValue(response.data)
      const data = objectValue(wrapper?.data)
      if (!wrapper || !data) throw new SkillsKeyIssueError("ISSUE_RESPONSE_INVALID", upstreamStatus)
      const hasMarker = "code" in wrapper || "success" in wrapper || "statusCode" in wrapper
      if (
        !hasMarker ||
        ("code" in wrapper && ![0, 200, 201].includes(wrapper.code as number)) ||
        ("success" in wrapper && wrapper.success !== true) ||
        ("statusCode" in wrapper && ![200, 201].includes(wrapper.statusCode as number)) ||
        data.phone !== phone ||
        !isValidKeyB(data.key)
      ) {
        throw new SkillsKeyIssueError("ISSUE_RESPONSE_INVALID", upstreamStatus)
      }
      return { phone, key: data.key }
    } catch (error) {
      // 不复用 AxiosError：其 config/request/response/cause 可能携带 KeyA、KeyB 与手机号。
      if (error instanceof SkillsKeyIssueError) throw error
      throw classifyIssueError(error)
    }
  }
}
