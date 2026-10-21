import { ForbiddenException, Injectable, ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

export const SKILLS_KEY_DEFAULT_PROJECT_CODE = "selleros"
export const SKILLS_KEY_ISSUE_TIMEOUT_MS = 15_000

export interface SkillsKeyProjectConfig {
  readonly code: string
  readonly projectId: string
  readonly apiOrigin: string
  readonly keyA: string
}

const CONFIG_NAMES = [
  "SKILLS_KEYS_API_ORIGIN",
  "SKILLS_KEYS_PROJECT_ID",
  "SKILLS_KEYS_PROJECT_KEY_A",
  "SKILLS_KEYS_ENCRYPTION_KEY",
] as const

/** 首版只有服务端登记的 SellerOS 项目；不得使用客户工作台 Project 配置。 */
@Injectable()
export class SkillsKeyConfigService {
  readonly enabled: boolean
  private readonly project: SkillsKeyProjectConfig | null
  private readonly encryptionKey: Buffer | null

  constructor(config: ConfigService) {
    const values = CONFIG_NAMES.map(name => {
      const value = config.get<unknown>(name)
      if (value == null || value === "") return ""
      if (typeof value !== "string") this.invalid(name)
      return value.trim()
    })
    this.enabled = values.some(Boolean)
    if (!this.enabled) {
      this.project = null
      this.encryptionKey = null
      return
    }

    values.forEach((value, index) => {
      if (!value) this.invalid(CONFIG_NAMES[index])
    })
    const [origin, projectId, keyA, encodedKey] = values

    let url: URL
    try {
      url = new URL(origin)
    } catch {
      this.invalid("SKILLS_KEYS_API_ORIGIN")
    }
    // 只允许固定 HTTPS origin，禁止凭证、路径、查询串和片段进入签发地址。
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (origin !== url.origin && origin !== `${url.origin}/`)
    ) {
      this.invalid("SKILLS_KEYS_API_ORIGIN")
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(projectId)) {
      this.invalid("SKILLS_KEYS_PROJECT_ID")
    }
    if (!/^[\x21-\x7e]{1,512}$/.test(keyA)) this.invalid("SKILLS_KEYS_PROJECT_KEY_A")

    const decodedKey = Buffer.from(encodedKey, "base64")
    if (decodedKey.length !== 32 || decodedKey.toString("base64") !== encodedKey) {
      this.invalid("SKILLS_KEYS_ENCRYPTION_KEY")
    }

    this.project = Object.freeze({
      code: SKILLS_KEY_DEFAULT_PROJECT_CODE,
      projectId,
      apiOrigin: url.origin,
      keyA,
    })
    this.encryptionKey = decodedKey
  }

  getProject(projectCode = SKILLS_KEY_DEFAULT_PROJECT_CODE): SkillsKeyProjectConfig {
    if (!this.project) throw this.disabled()
    if (projectCode !== this.project.code) {
      throw new ForbiddenException({
        code: "SKILLS_PROJECT_FORBIDDEN",
        message: "无权使用该接入项目",
      })
    }
    return this.project
  }

  getEncryptionKey(): Buffer {
    if (!this.encryptionKey) throw this.disabled()
    return Buffer.from(this.encryptionKey)
  }

  private disabled(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: "SKILLS_KEYS_DISABLED",
      message: "接入密钥功能尚未配置，请联系管理员",
    })
  }

  private invalid(name: string): never {
    // 仅记录配置名，不拼接配置值，避免启动错误泄露 KeyA 或加密主密钥。
    throw new Error(`接入密钥配置无效：${name}`)
  }
}
