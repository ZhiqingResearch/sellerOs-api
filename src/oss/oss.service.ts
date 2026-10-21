import { HttpService } from "@nestjs/axios"
import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import OSS from "ali-oss"
import type { Readable } from "stream"

@Injectable()
export class OssService {
  private readonly logger = new Logger(OssService.name)
  private readonly client: OSS
  private readonly baseUrl: string
  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    this.baseUrl = this.configService.get<string>("OSS_BASE_URL") || ""
    this.client = new OSS({
      accessKeyId: this.configService.get<string>("OSS_ACCESS_KEY_ID") || "",
      accessKeySecret: this.configService.get<string>("OSS_ACCESS_KEY_SECRET") || "",
      region: this.configService.get<string>("OSS_REGION"),
      bucket: this.configService.get<string>("OSS_BUCKET"),
      endpoint: this.configService.get<string>("OSS_ENDPOINT"),
      timeout: 600000, // 5 minutes
    })
  }

  /** 上传文件 Buffer 到 OSS，返回可访问 URL */
  async uploadBuffer(buffer: Buffer, key: string, mimeType: string): Promise<string> {
    await this.client.put(key, buffer, { mime: mimeType })
    const url = `${this.baseUrl.replace(/\/$/, "")}/${key.replace(/^\//, "")}`
    this.logger.log(`OSS 上传完成 [key=${key}, size=${buffer.length}B]`)
    return url
  }

  /**
   * 流式上传到 OSS，返回可访问 URL。
   * 适用于大文件（视频/长音频）—— 避免把整段二进制读进 Node 堆。
   * `contentLength` 若已知（如下游响应带 content-length）则透传，否则走分块编码。
   */
  async uploadStream(
    stream: Readable,
    key: string,
    mimeType: string,
    contentLength?: number
  ): Promise<string> {
    // @types/ali-oss 把 timeout/meta/callback 错标为必填；运行时这些字段是可选的，所以用 Partial 绕一下
    await this.client.putStream(key, stream, {
      mime: mimeType,
      ...(contentLength ? { contentLength } : {}),
    } as Partial<OSS.PutStreamOptions> as OSS.PutStreamOptions)
    const url = `${this.baseUrl.replace(/\/$/, "")}/${key.replace(/^\//, "")}`
    this.logger.log(`OSS 流式上传完成 [key=${key}, contentLength=${contentLength ?? "chunked"}]`)
    return url
  }

  generateOSSPolicy() {
    const date = new Date()
    // 设置签名的有效期，单位为秒。
    date.setSeconds(date.getSeconds() + 3600)

    const policy = {
      expiration: date.toISOString(),
      conditions: [
        // 设置上传文件的大小限制。
        ["content-length-range", 0, 1048576000],
        // 限制可上传的Bucket。
        { bucket: this.configService.get<string>("OSS_BUCKET") },
      ],
    }
    const formData = this.client.calculatePostSignature(policy)
    const host = this.baseUrl
    const params = {
      // expire,
      policy: formData.policy,
      signature: formData.Signature,
      ossAccessKeyId: formData.OSSAccessKeyId,
      host,
      dir: "/",
      // bucket: process.env.OSS_BUCKET || "aitemplate",
      // dir: "prefix/",
    }
    return params
  }
}
