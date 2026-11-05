/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
// 测试内存委托模拟异构 Prisma 表；生产逻辑由实际同步函数执行。
const user = { id: 7, username: "运营", phone: "13800000000", orgs: [], roles: [] }

function matches(row: any, where: any): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (value === undefined) return true
    if (key === "AND")
      return (Array.isArray(value) ? value : [value]).every(child => matches(row, child))
    if (key === "OR") return value.some((child: any) => matches(row, child))
    const actual = row[key]
    if (value === null || typeof value !== "object" || value instanceof Date)
      return actual === value
    if (key === "meta") {
      const field = value.path.slice(2)
      return row.meta?.[field] === value.equals
    }
    if ("in" in value) return value.in.includes(actual)
    if ("gt" in value) return actual > value.gt
    if ("not" in value) return actual !== value.not
    if ("startsWith" in value) return actual?.startsWith(value.startsWith)
    if ("gte" in value || "lte" in value)
      return (!value.gte || actual >= value.gte) && (!value.lte || actual <= value.lte)
    return matches(actual, value)
  })
}

export function memoryClient(initial: Record<string, any[]> = {}) {
  const data: Record<string, any[]> = {
    user: [user],
    aiGatewayModel: [{ publicId: "model-1", displayName: "实际模型一" }],
    ...initial,
  }
  const client: any = { $queryRaw: jest.fn().mockResolvedValue([]) }
  const delegate = (model: string) => {
    data[model] ??= []
    return {
      findMany: jest.fn(async (args: any = {}) =>
        data[model].filter(row => matches(row, args.where))
      ),
      findUnique: jest.fn(
        async ({ where }: any) => data[model].find(row => matches(row, where)) ?? null
      ),
      findFirst: jest.fn(
        async (args: any = {}) => data[model].find(row => matches(row, args.where)) ?? null
      ),
      count: jest.fn(
        async (args: any = {}) => data[model].filter(row => matches(row, args.where)).length
      ),
      updateMany: jest.fn(async ({ where, data: patch }: any) => {
        const rows = data[model].filter(row => matches(row, where))
        rows.forEach(row => Object.assign(row, patch))
        return { count: rows.length }
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        data[model] = data[model].filter(row => !matches(row, where))
        return { count: 0 }
      }),
      create: jest.fn(async ({ data: row }: any) => {
        const result = { id: data[model].length + 1, ...row }
        data[model].push(result)
        return result
      }),
      update: jest.fn(async ({ where, data: patch }: any) => {
        const row = data[model].find(row => matches(row, where))
        Object.assign(row, patch)
        return row
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const identity = where.sourceType_sourceId_operation
        let row = data[model].find(row => matches(row, identity))
        if (row) Object.assign(row, update)
        else {
          row = { id: BigInt(data[model].length + 1), ...create }
          data[model].push(row)
        }
        return row
      }),
    }
  }
  for (const name of [
    "user",
    "aiGatewayModel",
    "generationRecord",
    "generationTask",
    "generatedImage",
    "imageGenJob",
    "videoTask",
    "storyboardVideo",
    "beautyTask",
    "rpaCreationTask",
    "inspirationSubscription",
    "usageLog",
    "creditTransaction",
    "history",
    "businessAiRun",
    "categoryAnalysisRecord",
    "selectionAnalysisRecord",
    "smartPricingRecord",
    "promotionPlanRecord",
    "videoAnalysisRecord",
    "asinEvidenceRecord",
    "asinAuditRecord",
    "asinAuditScoreSnapshot",
    "asinAuditOptimizationRevision",
    "competitorAnalysisRecord",
    "chetaidouTask",
    "chetaidouCall",
    "listingRun",
    "listingAiStep",
    "historyRevision",
    "imageGenItem",
    "rpaCreationOutput",
  ])
    client[name] = delegate(name)
  // Compound identity is intentionally strict: Prisma findMany cannot accept WhereUnique compound keys.
  client.generationRecord.findUnique.mockImplementation(
    async ({ where }: any) =>
      data.generationRecord.find(row => matches(row, where.sourceType_sourceId_operation)) ?? null
  )
  return { tx: client, data }
}
