/** 单个抓取生产者和有限数量的处理消费者；队列满时暂停领取，失败后等待在途任务退出。 */
export async function runTaskPipeline<T, U>(options: {
  tasks: T[]
  workerCount: number
  queueLimit: number
  shouldStop: () => boolean
  prepare: (task: T) => Promise<U | undefined>
  process: (item: U) => Promise<void>
  onProgress?: (queuedCount: number, activeCount: number, isProducerDone: boolean) => void
  onFailure?: () => void
}) {
  const queue: U[] = []
  let isProducerDone = false
  let hasFailed = false
  let failure: unknown
  let activeCount = 0
  let wake: () => void
  let changed: Promise<void>
  const resetSignal = () => {
    changed = new Promise<void>(resolveSignal => {
      wake = resolveSignal
    })
  }
  resetSignal()
  const notify = () => {
    wake()
    resetSignal()
    options.onProgress?.(queue.length, activeCount, isProducerDone)
  }
  const guard = async (operation: () => Promise<void>) => {
    try {
      await operation()
    } catch (error) {
      if (!hasFailed) failure = error
      hasFailed = true
      wake()
      options.onFailure?.()
    }
  }
  const producer = guard(async () => {
    try {
      for (const task of options.tasks) {
        while (!hasFailed && !options.shouldStop() && queue.length >= options.queueLimit)
          await changed
        if (hasFailed || options.shouldStop()) break
        const item = await options.prepare(task)
        if (item !== undefined) queue.push(item)
        notify()
      }
    } finally {
      isProducerDone = true
      notify()
    }
  })
  const consumers = Array.from({ length: options.workerCount }, () =>
    guard(async () => {
      while (!hasFailed && !options.shouldStop()) {
        if (!queue.length) {
          if (isProducerDone) break
          await changed
          continue
        }
        const item = queue.shift()!
        activeCount += 1
        notify()
        try {
          await options.process(item)
        } finally {
          activeCount -= 1
          notify()
        }
      }
    })
  )
  await Promise.all([producer, ...consumers])
  if (hasFailed) throw failure
}
