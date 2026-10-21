import { Test } from "@nestjs/testing"
import { PrismaService } from "../prisma/prisma.service"
import { SelectedProductService } from "./selected-product.service"

describe("SelectedProductService", () => {
  let service: SelectedProductService
  let prisma: {
    selectedProduct: { createMany: jest.Mock }
  }

  beforeEach(async () => {
    prisma = {
      selectedProduct: { createMany: jest.fn() },
    }

    const module = await Test.createTestingModule({
      providers: [SelectedProductService, { provide: PrismaService, useValue: prisma }],
    }).compile()

    service = module.get(SelectedProductService)
  })

  describe("createBatch", () => {
    it("should batch create selected products", async () => {
      prisma.selectedProduct.createMany.mockResolvedValue({ count: 3 })

      const result = await service.createBatch(1, { productCodes: ["P001", "P002", "P003"] })

      expect(result).toEqual({ count: 3 })
      expect(prisma.selectedProduct.createMany).toHaveBeenCalledWith({
        data: [
          { productCode: "P001", userId: 1 },
          { productCode: "P002", userId: 1 },
          { productCode: "P003", userId: 1 },
        ],
      })
    })

    it("should handle single product", async () => {
      prisma.selectedProduct.createMany.mockResolvedValue({ count: 1 })

      const result = await service.createBatch(1, { productCodes: ["P001"] })

      expect(result).toEqual({ count: 1 })
    })
  })
})
