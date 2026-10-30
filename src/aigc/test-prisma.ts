/** 老业务单测的终态CAS脚本独立于新增回执写入；真实回执恢复由image-delivery-recovery.spec覆盖。 */
export function withDeliveryCheckpoint<T extends object>(prisma: T): T {
  return new Proxy(prisma, {
    get(target, key, receiver) {
      if (key !== "generatedImage" && key !== "imageGenItem")
        return Reflect.get(target, key, receiver) as unknown
      const table = Reflect.get(target, key, receiver) as {
        updateMany: (args: { data?: Record<string, unknown> }) => Promise<unknown>
      }
      return {
        ...table,
        updateMany: (args: { data?: Record<string, unknown> }) =>
          args.data?.deliverySource ? Promise.resolve({ count: 1 }) : table.updateMany(args),
      }
    },
  })
}
