import { NotFoundException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { PrismaService } from "../prisma/prisma.service"
import { ProductReportService } from "./product-report.service"

describe("ProductReportService", () => {
  let service: ProductReportService
  let prisma: {
    productReport: {
      findMany: jest.Mock
      findUnique: jest.Mock
      count: jest.Mock
      create: jest.Mock
      delete: jest.Mock
    }
  }

  beforeEach(async () => {
    prisma = {
      productReport: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
    }

    const module = await Test.createTestingModule({
      providers: [ProductReportService, { provide: PrismaService, useValue: prisma }],
    }).compile()

    service = module.get(ProductReportService)
  })

  describe("findByUser", () => {
    it("should return paginated results", async () => {
      const mockItems = [
        {
          id: 1,
          title: "报告A",
          score: 90,
          description: "描述",
          reportUrl: null,
          createdAt: new Date(),
        },
      ]
      prisma.productReport.findMany.mockResolvedValue(mockItems)
      prisma.productReport.count.mockResolvedValue(1)

      const result = await service.findByUser(1, { page: 1, pageSize: 10 })

      expect(result.items).toEqual(mockItems)
      expect(result.total).toBe(1)
      expect(result.totalPages).toBe(1)
    })

    it("should calculate pagination correctly", async () => {
      prisma.productReport.findMany.mockResolvedValue([])
      prisma.productReport.count.mockResolvedValue(25)

      const result = await service.findByUser(1, { page: 3, pageSize: 10 })

      expect(result.totalPages).toBe(3)
      expect(prisma.productReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 })
      )
    })
  })

  describe("findById", () => {
    it("should return record when found", async () => {
      const mock = { id: 1, title: "报告A", userId: 1 }
      prisma.productReport.findUnique.mockResolvedValue(mock)

      const result = await service.findById(1)
      expect(result).toEqual(mock)
    })

    it("should throw NotFoundException when not found", async () => {
      prisma.productReport.findUnique.mockResolvedValue(null)

      await expect(service.findById(999)).rejects.toThrow(NotFoundException)
    })
  })

  describe("create", () => {
    it("should create a product report", async () => {
      const dto = {
        title: "报告A",
        score: 90,
        description: "描述",
        data: {},
        reportUrl: "https://example.com",
      }
      const mock = { id: 1, ...dto, userId: 1 }
      prisma.productReport.create.mockResolvedValue(mock)

      const result = await service.create(1, dto)
      expect(result).toEqual(mock)
    })
  })

  describe("remove", () => {
    it("should delete record when found", async () => {
      prisma.productReport.findUnique.mockResolvedValue({ id: 1, userId: 1 })
      prisma.productReport.delete.mockResolvedValue({})

      await service.remove(1, 1)

      expect(prisma.productReport.delete).toHaveBeenCalledWith({ where: { id: 1 } })
    })

    it("should throw NotFoundException when not found", async () => {
      prisma.productReport.findUnique.mockResolvedValue(null)

      await expect(service.remove(999, 1)).rejects.toThrow(NotFoundException)
    })
  })
})
