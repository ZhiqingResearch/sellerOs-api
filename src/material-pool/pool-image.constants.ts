// 素材图类型（PoolImage.kind）：image=普通素材图；competitor=AI 拆图竞品参考图。
// 写入侧统一从这里取值，防止字符串散落；分享码导入按源图原样复制 kind。
export const POOL_IMAGE_KINDS = ["image", "competitor"] as const
export type PoolImageKind = (typeof POOL_IMAGE_KINDS)[number]

export const POOL_IMAGE_KIND = {
  IMAGE: "image",
  COMPETITOR: "competitor",
} as const satisfies Record<string, PoolImageKind>
