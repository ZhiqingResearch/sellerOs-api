import { BadRequestException, ServiceUnavailableException } from "@nestjs/common"
import type { LookupAddress } from "node:dns"
import { lookup } from "node:dns/promises"
import { Agent, type RequestOptions } from "node:https"
import { BlockList, isIP } from "node:net"
import type { Duplex } from "node:stream"
import { connect } from "node:tls"

// IANA特殊用途网段；另限制IPv6为全球单播，排除映射/转换地址对IPv4校验的绕过。
const blocked = new BlockList()
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4")
blocked.addAddress("168.63.129.16", "ipv4")
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3ffe::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6")
const globalV6 = new BlockList()
globalV6.addSubnet("2000::", 3, "ipv6")

export function isPublicMediaAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6")
}

function invalidAddress(message = "素材地址必须是安全的公网 HTTPS 域名地址") {
  return new BadRequestException({ code: "MODERATION_INVALID_INPUT", message })
}

export function validatePublicMediaUrl(value: string | undefined): URL {
  let url: URL
  try {
    url = new URL(value || "")
  } catch {
    throw invalidAddress()
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "")
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    isIP(hostname.replace(/^\[|\]$/g, "")) ||
    !hostname ||
    /(?:^|\.)(?:localhost|local|internal)$/.test(hostname) ||
    hostname.endsWith(".home.arpa")
  )
    throw invalidAddress()
  return url
}

class PinnedMediaAgent extends Agent {
  constructor(
    private readonly hostname: string,
    private readonly target: LookupAddress
  ) {
    super({ keepAlive: false })
  }

  override createConnection(
    options: RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void
  ): undefined {
    if (!callback) throw invalidAddress()
    // 直接连接已检查的IP，不再次解析DNS；Host由原请求保留，证书仍校验原域名。
    const socket = connect({
      ...options,
      host: this.target.address,
      port: 443,
      path: undefined,
      servername: this.hostname,
      rejectUnauthorized: true,
    })
    let finished = false
    const finish = (error: Error | null) => {
      if (finished) return
      finished = true
      if (error) socket.destroy()
      callback(error, socket)
    }
    socket.once("error", finish)
    socket.setTimeout(60_000, () => finish(new Error("素材TLS连接超时")))
    socket.once("secureConnect", () => {
      const peer = socket.remoteAddress
      const expected = new BlockList()
      const type = this.target.family === 4 ? "ipv4" : "ipv6"
      expected.addAddress(this.target.address, type)
      if (!peer || !isPublicMediaAddress(peer) || !expected.check(peer, type)) {
        finish(invalidAddress("素材实际连接地址未通过公网校验"))
      } else finish(null)
    })
    return undefined
  }
}

export async function publicMediaDownloadAgent(value: string): Promise<Agent> {
  const url = validatePublicMediaUrl(value)
  let timer: NodeJS.Timeout | undefined
  let addresses: LookupAddress[]
  try {
    addresses = await Promise.race([
      lookup(url.hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("DNS timeout")), 10_000)
      }),
    ])
  } catch {
    throw new ServiceUnavailableException({
      code: "MODERATION_DNS_UNAVAILABLE",
      message: "素材域名暂时无法解析，请稍后重试",
    })
  } finally {
    clearTimeout(timer)
  }
  if (
    !addresses.length ||
    addresses.some(
      item => !isPublicMediaAddress(item.address) || isIP(item.address) !== item.family
    )
  ) {
    throw invalidAddress("素材域名必须解析到公网地址，禁止访问本机、内网和特殊用途地址")
  }
  return new PinnedMediaAgent(
    url.hostname,
    addresses.find(item => item.family === 4) || addresses[0]
  )
}
