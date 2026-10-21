export const PRODUCT_PUBLISH_RPA_TASK_TYPES = [
  "download_listing",
  "upload_listing",
  "check_feed_status",
] as const

export type ProductPublishRpaTaskType = (typeof PRODUCT_PUBLISH_RPA_TASK_TYPES)[number]

interface ProductPublishRpaTaskInfoBase {
  task_id: string
  rpa_storage: string
}

export type ProductPublishRpaTaskInfo =
  | (ProductPublishRpaTaskInfoBase & {
      task_type: "download_listing"
      task_param: { category: string }
    })
  | (ProductPublishRpaTaskInfoBase & {
      task_type: "upload_listing"
      task_param: { file_url: string }
    })
  | (ProductPublishRpaTaskInfoBase & {
      task_type: "check_feed_status"
      // upload_id 由 RPA 调用 Amazon 服务后取得，是 Amazon 业务批次 ID，不是 RPA 标识。
      task_param: { upload_id: string; skus: string[] }
    })

export interface ProductPublishRpaBusinessRequest {
  business_type: "Amazon"
  business_id: string
  tasks_info: ProductPublishRpaTaskInfo[]
}

export type ProductPublishRpaRequest = ProductPublishRpaBusinessRequest[]

interface ProductPublishRpaRequestBase {
  businessId: string
}

type BuildProductPublishRpaRequestInput = ProductPublishRpaRequestBase &
  (
    | { taskType: "download_listing"; taskParam: { category: string } }
    | { taskType: "upload_listing"; taskParam: { file_url: string } }
    | { taskType: "check_feed_status"; taskParam: { upload_id: string; skus: string[] } }
  )

/**
 * 构造一键上架 RPA 的业务参数。影刀调度输入中的 task_id / rpa_storage
 * 当前固定为空字符串，不开放给调用方覆盖。
 */
export function buildProductPublishRpaRequest(
  input: BuildProductPublishRpaRequestInput
): ProductPublishRpaRequest {
  if (!/^\d{1,32}$/.test(input.businessId)) {
    throw new Error("RPA 业务店铺ID必须是1到32位纯数字字符串")
  }
  if (!PRODUCT_PUBLISH_RPA_TASK_TYPES.includes(input.taskType)) {
    throw new Error("RPA task_type不受支持")
  }
  if (
    input.taskType === "download_listing" &&
    (!/^[A-Z0-9]+(?: [A-Z0-9]+)*$/.test(input.taskParam.category) ||
      input.taskParam.category.length > 100)
  ) {
    throw new Error("RPA 模板分类编码格式错误")
  }
  if (
    input.taskType === "upload_listing" &&
    (!input.taskParam.file_url.trim() || input.taskParam.file_url.length > 1000)
  ) {
    throw new Error("RPA 上架文件URL不能为空且不能超过1000个字符")
  }
  if (
    input.taskType === "check_feed_status" &&
    (!input.taskParam.upload_id.trim() || input.taskParam.upload_id.length > 100)
  ) {
    throw new Error("Amazon upload_id不能为空且不能超过100个字符")
  }
  if (input.taskType === "check_feed_status") {
    if (!Array.isArray(input.taskParam.skus) || input.taskParam.skus.length === 0) {
      throw new Error("Amazon 结果查询 skus 必须是非空数组")
    }
    if (input.taskParam.skus.length > 100_000) {
      throw new Error("Amazon 结果查询 skus 不能超过100000个")
    }
    const seen = new Set<string>()
    for (const rawSku of input.taskParam.skus) {
      if (typeof rawSku !== "string") {
        throw new Error("Amazon 结果查询 SKU 必须是字符串")
      }
      const sku = rawSku.trim()
      if (!sku || sku.length > 200) {
        throw new Error("Amazon 结果查询 SKU 不能为空且不能超过200个字符")
      }
      if (seen.has(sku)) throw new Error(`Amazon 结果查询 SKU 重复：${sku}`)
      seen.add(sku)
    }
  }

  const common = {
    task_id: "",
    rpa_storage: "",
  }
  let taskInfo: ProductPublishRpaTaskInfo
  if (input.taskType === "download_listing") {
    taskInfo = {
      ...common,
      task_type: "download_listing",
      task_param: { category: input.taskParam.category },
    }
  } else if (input.taskType === "upload_listing") {
    taskInfo = {
      ...common,
      task_type: "upload_listing",
      task_param: { file_url: input.taskParam.file_url },
    }
  } else {
    taskInfo = {
      ...common,
      task_type: "check_feed_status",
      task_param: {
        upload_id: input.taskParam.upload_id,
        skus: input.taskParam.skus.map(sku => sku.trim()),
      },
    }
  }

  return [
    {
      business_type: "Amazon",
      business_id: input.businessId,
      tasks_info: [taskInfo],
    },
  ]
}
