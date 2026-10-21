/**
 * 短时 in-flight 共享 + 已解析缓存（等价迁移交付包 server/utils/memoize.ts）。
 * SIF 取证用：同 ASIN 重复审计在 1h 内不重复烧配额；失败立即驱逐不缓存。
 * 进程内 Map，水平扩展下各实例独立缓存。
 */

interface CachedEntry<T> {
  promise: Promise<T>
  expiresAt: number | null
  pending: boolean
}

const store = new Map<string, CachedEntry<unknown>>()

const DEFAULT_TTL_MS = 30_000

export function memoizeByKey<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<T> {
  const existing = store.get(key) as CachedEntry<T> | undefined
  const now = Date.now()
  if (existing && (existing.pending || (existing.expiresAt ?? 0) > now)) {
    return existing.promise
  }

  const entry = { expiresAt: null, pending: true } as CachedEntry<T>
  entry.promise = (async () => {
    try {
      return await fn()
    } catch (err) {
      if (store.get(key) === entry) store.delete(key)
      throw err
    }
  })()

  entry.promise.then(
    () => {
      entry.pending = false
      entry.expiresAt = Date.now() + ttlMs
    },
    () => {
      // 已在 catch 中驱逐
    }
  )

  store.set(key, entry)
  return entry.promise
}

export const __memoizeTesting = {
  reset(): void {
    store.clear()
  },
  size(): number {
    return store.size
  },
}
