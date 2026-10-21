import { Injectable, ServiceUnavailableException } from "@nestjs/common"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto"
import { SkillsKeyConfigService } from "./skills-key-config.service"

export const SKILLS_KEY_ENCRYPTION_VERSION = "v1"

export function isValidKeyB(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    /^(?:zk-|sk_)[A-Za-z0-9_-]{1,509}$/.test(value)
  )
}

export interface EncryptedSkillsKey {
  keyCiphertext: string
  encryptionVersion: string
  keyHash: string
  maskedKey: string
}

@Injectable()
export class SkillsKeyCryptoService {
  constructor(private readonly config: SkillsKeyConfigService) {}

  encrypt(key: string, userId: number, projectId: string): EncryptedSkillsKey {
    const masterKey = this.config.getEncryptionKey()
    try {
      if (!isValidKeyB(key)) throw new Error("凭证格式无效")
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", masterKey, iv)
      cipher.setAAD(this.aad(userId, projectId))
      const ciphertext = Buffer.concat([cipher.update(key, "utf8"), cipher.final()])
      const tag = cipher.getAuthTag()
      return {
        keyCiphertext: [iv, tag, ciphertext].map(value => value.toString("base64")).join("."),
        encryptionVersion: SKILLS_KEY_ENCRYPTION_VERSION,
        keyHash: this.hash(key),
        maskedKey: this.mask(key),
      }
    } catch {
      throw this.cryptoError()
    } finally {
      masterKey.fill(0)
    }
  }

  decrypt(
    keyCiphertext: string,
    encryptionVersion: string,
    userId: number,
    projectId: string
  ): string {
    const masterKey = this.config.getEncryptionKey()
    try {
      if (encryptionVersion !== SKILLS_KEY_ENCRYPTION_VERSION) throw new Error("版本不支持")
      const parts = keyCiphertext.split(".")
      if (parts.length !== 3) throw new Error("密文格式无效")
      const [iv, tag, ciphertext] = parts.map(part => {
        const value = Buffer.from(part, "base64")
        if (!part || value.toString("base64") !== part) throw new Error("密文格式无效")
        return value
      })
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 512) {
        throw new Error("密文格式无效")
      }
      const decipher = createDecipheriv("aes-256-gcm", masterKey, iv)
      decipher.setAAD(this.aad(userId, projectId))
      decipher.setAuthTag(tag)
      const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
      if (!isValidKeyB(key)) throw new Error("凭证格式无效")
      return key
    } catch {
      throw this.cryptoError()
    } finally {
      masterKey.fill(0)
    }
  }

  hash(key: string): string {
    return createHash("sha256").update(key, "utf8").digest("hex")
  }

  mask(key: string): string {
    // 短凭证不能因为首尾拼接而暴露全值。
    return key.length > 11 ? `${key.slice(0, 3)}****${key.slice(-4)}` : `${key.slice(0, 3)}****`
  }

  private aad(userId: number, projectId: string): Buffer {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !projectId) {
      throw new Error("凭证归属无效")
    }
    return Buffer.from(
      JSON.stringify(["selleros-skills-key", SKILLS_KEY_ENCRYPTION_VERSION, userId, projectId])
    )
  }

  private cryptoError(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: "SKILLS_KEY_CRYPTO_ERROR",
      message: "接入密钥暂时无法读取或保存，请联系管理员",
    })
  }
}
