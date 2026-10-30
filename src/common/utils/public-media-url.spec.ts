import { lookup } from "node:dns/promises"
import { EventEmitter } from "node:events"
import { connect } from "node:tls"
import {
  isPublicMediaAddress,
  publicMediaDownloadAgent,
  validatePublicMediaUrl,
} from "./public-media-url"

jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }))
jest.mock("node:tls", () => ({ connect: jest.fn() }))

describe("公网素材URL与固定IP连接", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never)
  })

  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.100.100.200",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.0.8",
    "192.0.2.1",
    "198.18.0.17",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "168.63.129.16",
    "::",
    "::1",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::a00:1",
    "2001::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "3fff::1",
    "invalid",
  ])("特殊、内网或转换IP %s 不允许", address => {
    expect(isPublicMediaAddress(address)).toBe(false)
  })

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "公网IP %s 允许",
    address => {
      expect(isPublicMediaAddress(address)).toBe(true)
    }
  )

  it.each([
    "http://m.media-amazon.com/a.jpg",
    "file:///etc/passwd",
    "https://localhost/a",
    "https://localhost./a",
    "https://app.local/a",
    "https://metadata.google.internal/a",
    "https://127.0.0.1/a",
    "https://2130706433/a",
    "https://0x7f000001/a",
    "https://[::1]/a",
    "https://[::ffff:127.0.0.1]/a",
    "https://user:pass@example.com/a",
    "https://example.com:8443/a",
    "https://example.com/a#b",
  ])("不安全URL %s 在DNS和下载前拒绝", url => {
    expect(() => validatePublicMediaUrl(url)).toThrow()
    expect(lookup).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it("外部HTTPS域名无需名单，查询参数原样保留", () => {
    const url = "https://m.media-amazon.com/images/a.jpg?signature=opaque"
    expect(validatePublicMediaUrl(url).href).toBe(url)
  })

  it("任何一个DNS结果为非公网即拒绝，不能回退到内网IPv6", async () => {
    jest.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "fd00::1", family: 6 },
    ] as never)
    await expect(publicMediaDownloadAgent("https://untrusted.example/a.jpg")).rejects.toMatchObject(
      { response: { code: "MODERATION_INVALID_INPUT" } }
    )
    expect(connect).not.toHaveBeenCalled()
  })

  it("DNS错误被脱敏并停止，不能当作公网或直接下载", async () => {
    jest.mocked(lookup).mockRejectedValue(new Error("private-dns-details"))
    await expect(publicMediaDownloadAgent("https://example.com/a")).rejects.toMatchObject({
      response: { code: "MODERATION_DNS_UNAVAILABLE" },
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it("DNS慢查询到期失败，不会无限等待", async () => {
    jest.useFakeTimers()
    try {
      jest.mocked(lookup).mockReturnValue(new Promise(() => {}) as never)
      const pending = expect(
        publicMediaDownloadAgent("https://example.com/a")
      ).rejects.toMatchObject({ response: { code: "MODERATION_DNS_UNAVAILABLE" } })
      await jest.advanceTimersByTimeAsync(10_001)
      await pending
    } finally {
      jest.useRealTimers()
    }
  })

  it.each(["93.184.216.34", "127.0.0.1", "8.8.8.8"])(
    "连接固定到已验证IP并在TLS完成后核对实际地址 %s",
    async peer => {
      const socket = Object.assign(new EventEmitter(), {
        remoteAddress: peer,
        setTimeout: jest.fn(),
        destroy: jest.fn(),
      })
      jest.mocked(connect).mockReturnValue(socket as never)
      const agent = await publicMediaDownloadAgent("https://m.media-amazon.com/a.jpg")
      // 后续DNS即使改变也不会再解析，连接目标仍是第一次检查的IP。
      jest.mocked(lookup).mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never)
      const ready = jest.fn()
      expect(
        agent.createConnection({ host: "m.media-amazon.com", port: 443 }, ready)
      ).toBeUndefined()
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "93.184.216.34",
          port: 443,
          servername: "m.media-amazon.com",
          rejectUnauthorized: true,
          path: undefined,
        })
      )
      expect(ready).not.toHaveBeenCalled()
      socket.emit("secureConnect")
      expect(lookup).toHaveBeenCalledTimes(1)
      if (peer === "93.184.216.34") expect(ready).toHaveBeenCalledWith(null, socket)
      else {
        expect(ready).toHaveBeenCalledWith(expect.any(Error), socket)
        expect(socket.destroy).toHaveBeenCalledTimes(1)
      }
      agent.destroy()
    }
  )
})
