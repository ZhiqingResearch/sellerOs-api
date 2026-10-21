import { ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { createHash } from "crypto"
import { SkillsKeyConfigService } from "./skills-key-config.service"
import { isValidKeyB, SkillsKeyCryptoService } from "./skills-key-crypto.service"

const testKey = "zk-test-only-never-issued-credential"
const projectId = "test-project"

function cryptoService(masterKeyByte = 3): SkillsKeyCryptoService {
  const config = new SkillsKeyConfigService(
    new ConfigService({
      SKILLS_KEYS_API_ORIGIN: "https://skills.example.invalid",
      SKILLS_KEYS_PROJECT_ID: projectId,
      SKILLS_KEYS_PROJECT_KEY_A: "test-only-project-key",
      SKILLS_KEYS_ENCRYPTION_KEY: Buffer.alloc(32, masterKeyByte).toString("base64"),
    })
  )
  return new SkillsKeyCryptoService(config)
}

describe("SkillsKeyCryptoService", () => {
  it("使用随机 IV 加密，可用同一用户/项目解密，明文不落密文或展示值", () => {
    const service = cryptoService()
    const first = service.encrypt(testKey, 10, projectId)
    const second = service.encrypt(testKey, 10, projectId)
    expect(first.keyCiphertext).not.toEqual(second.keyCiphertext)
    expect(first.keyCiphertext).not.toContain(testKey)
    expect(first.encryptionVersion).toBe("v1")
    expect(first.maskedKey).toBe("zk-****tial")
    expect(first.keyHash).toBe(createHash("sha256").update(testKey).digest("hex"))
    expect(first.keyHash).toBe(second.keyHash)
    expect(service.decrypt(first.keyCiphertext, first.encryptionVersion, 10, projectId)).toBe(
      testKey
    )
  })

  it("旧 sk_ 前缀和短 token 可保存，短 token 的脱敏值不泄露原值", () => {
    const service = cryptoService()
    const value = service.encrypt("sk_test", 10, projectId)
    expect(value.maskedKey).toBe("sk_****")
    expect(service.decrypt(value.keyCiphertext, "v1", 10, projectId)).toBe("sk_test")
  })

  it("拒绝把密文复制到其他用户或接入项目，也拒绝错误的加密主密钥", () => {
    const service = cryptoService()
    const value = service.encrypt(testKey, 10, projectId)
    expect(() => service.decrypt(value.keyCiphertext, "v1", 11, projectId)).toThrow(
      ServiceUnavailableException
    )
    expect(() => service.decrypt(value.keyCiphertext, "v1", 10, "other-project")).toThrow(
      ServiceUnavailableException
    )
    expect(() => cryptoService(4).decrypt(value.keyCiphertext, "v1", 10, projectId)).toThrow(
      ServiceUnavailableException
    )
  })

  it.each([0, 1, 2])("拒绝被篡改的密文组成部分 %i，异常不包含敏感材料", part => {
    const service = cryptoService()
    const value = service.encrypt(testKey, 10, projectId)
    const parts = value.keyCiphertext.split(".")
    const bytes = Buffer.from(parts[part], "base64")
    bytes[0] ^= 1
    parts[part] = bytes.toString("base64")
    try {
      service.decrypt(parts.join("."), "v1", 10, projectId)
      throw new Error("应拒绝被篡改的密文")
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException)
      expect(JSON.stringify(error)).not.toContain(testKey)
      expect(JSON.stringify(error)).not.toContain(value.keyCiphertext)
    }
  })

  it("拒绝未知版本、格式错误和无效身份归属", () => {
    const service = cryptoService()
    const value = service.encrypt(testKey, 10, projectId)
    expect(() => service.decrypt(value.keyCiphertext, "v2", 10, projectId)).toThrow(
      ServiceUnavailableException
    )
    expect(() => service.decrypt("invalid", "v1", 10, projectId)).toThrow(
      ServiceUnavailableException
    )
    expect(() => service.decrypt(`${value.keyCiphertext}!`, "v1", 10, projectId)).toThrow(
      ServiceUnavailableException
    )
    expect(() => service.encrypt(testKey, 0, projectId)).toThrow(ServiceUnavailableException)
    expect(() => service.encrypt(testKey, 10, "")).toThrow(ServiceUnavailableException)
  })

  it.each(["", "zk-", "bad-prefix", "zk-test\n", "zk-test test", `zk-${"a".repeat(510)}`, null])(
    "拒绝无效 KeyB：%p",
    key => {
      expect(isValidKeyB(key)).toBe(false)
    }
  )
})
