import { CustomerService } from "./customer.service"

it("视频转存SQL在取批次前排除两个存储域且不匹配仿冒域名", async () => {
  const service = Object.create(CustomerService.prototype) as CustomerService
  const findMany = jest.fn<Promise<never[]>, [unknown]>().mockResolvedValue([])
  Object.assign(service, {
    spaces: {
      managedUrlPrefixes: () => ["https://oss.example/assets/", "https://spaces.example/"],
    },
    prisma: { script: { findMany } },
    logger: { log: jest.fn(), error: jest.fn(), debug: jest.fn() },
  })
  await service.cronPersistPendingVideos()
  expect(findMany.mock.calls[0][0]).toEqual({
    where: {
      videoStatus: "SUCCESS",
      deletedAt: null,
      AND: [
        { videoUrl: { not: null } },
        { NOT: { videoUrl: { startsWith: "https://oss.example/assets/" } } },
        { NOT: { videoUrl: { startsWith: "https://spaces.example/" } } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: 10,
  })
})
