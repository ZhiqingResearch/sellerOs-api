import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { ConfigService } from "@nestjs/config"
import { SpacesService } from "./spaces.service"

const send = jest.fn<
  Promise<{ Body: { transformToByteArray: () => Promise<Buffer> } }>,
  [GetObjectCommand]
>()
jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual<typeof import("@aws-sdk/client-s3")>("@aws-sdk/client-s3")
  return { ...actual, S3Client: jest.fn().mockImplementation(() => ({ send })) }
})
jest.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: jest.fn() }))

describe("裁剪公开直传 SDK 契约", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(getSignedUrl).mockResolvedValue("signed-put")
  })
  function service() {
    return new SpacesService(
      new ConfigService({
        SPACES_BUCKET: "bucket",
        SPACES_BASE_URL: "https://assets.example",
        SPACES_KEY: "test",
        SPACES_SECRET: "test",
      })
    )
  }
  it("用户元数据写入 PUT 并加入签名，前端按 headers 直传", async () => {
    const response = await service().generateUploadUrl({
      key: "chetaidou/crops/7/a.png",
      contentType: "image/png",
      metadata: { "owner-id": "7" },
    })
    expect(response.headers).toEqual({
      "x-amz-acl": "public-read",
      "Content-Type": "image/png",
      "x-amz-meta-owner-id": "7",
    })
    expect(response.publicUrl).toBe("https://assets.example/chetaidou/crops/7/a.png")
    const call = jest.mocked(getSignedUrl).mock.calls[0]
    expect(call[1]).toBeInstanceOf(PutObjectCommand)
    expect((call[1] as PutObjectCommand).input).toMatchObject({
      ACL: "public-read",
      Metadata: { "owner-id": "7" },
    })
    expect(call[2]).toMatchObject({
      unhoistableHeaders: new Set(["x-amz-acl", "content-type", "x-amz-meta-owner-id"]),
      signableHeaders: new Set(["content-type", "x-amz-meta-owner-id"]),
    })
  })
  it("旧公开上传不新增元数据头，范围读取只读 PNG 头", async () => {
    const storage = service()
    const response = await storage.generateUploadUrl({
      key: "uploads/a.png",
      contentType: "image/png",
    })
    expect(response.headers).toEqual({ "x-amz-acl": "public-read", "Content-Type": "image/png" })
    send.mockResolvedValue({
      Body: { transformToByteArray: () => Promise.resolve(Buffer.from("header")) },
    })
    expect(await storage.downloadBuffer("uploads/a.png", "bytes=0-32")).toEqual(
      Buffer.from("header")
    )
    const command = send.mock.calls[0][0]
    expect(command.input).toMatchObject({ Range: "bytes=0-32" })
  })
})
