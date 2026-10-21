import { buildProductPublishRpaRequest } from "./product-publish-rpa.contract"

describe("buildProductPublishRpaRequest", () => {
  const cases = [
    {
      input: {
        businessId: "27826971599669",
        taskType: "download_listing" as const,
        taskParam: { category: "NOTEBOOK COMPUTER" },
      },
    },
    {
      input: {
        businessId: "27826971599669",
        taskType: "upload_listing" as const,
        taskParam: { file_url: "https://public.example.com/input.xlsx" },
      },
    },
    {
      input: {
        businessId: "27826971599669",
        taskType: "check_feed_status" as const,
        taskParam: {
          upload_id: "6b1ccdde-16f4-41e4-99d1-5d1ff273c02d",
          skus: ["SKU-001", "SKU-002"],
        },
      },
    },
  ] satisfies Array<{ input: Parameters<typeof buildProductPublishRpaRequest>[0] }>

  it.each(cases)("构造 $input.taskType 的统一业务主体", ({ input }) => {
    expect(buildProductPublishRpaRequest(input)).toEqual([
      {
        business_type: "Amazon",
        business_id: "27826971599669",
        tasks_info: [
          {
            task_type: input.taskType,
            task_id: "",
            rpa_storage: "",
            task_param: input.taskParam,
          },
        ],
      },
    ])
  })

  it("拒绝会丢失精度或格式错误的店铺ID", () => {
    expect(() =>
      buildProductPublishRpaRequest({
        businessId: "27826971599669.0",
        taskType: "download_listing",
        taskParam: { category: "HEADPHONES" },
      })
    ).toThrow("纯数字字符串")
  })

  it("拒绝带下划线的模板分类编码", () => {
    expect(() =>
      buildProductPublishRpaRequest({
        businessId: "27826971599669",
        taskType: "download_listing",
        taskParam: { category: "NOTEBOOK_COMPUTER" },
      })
    ).toThrow("模板分类编码格式错误")
  })

  it("拒绝与动作对应但内容为空的业务参数", () => {
    expect(() =>
      buildProductPublishRpaRequest({
        businessId: "27826971599669",
        taskType: "check_feed_status",
        taskParam: { upload_id: "", skus: ["SKU-001"] },
      })
    ).toThrow("upload_id不能为空")
  })

  it("拒绝空 SKU 列表和重复 SKU", () => {
    expect(() =>
      buildProductPublishRpaRequest({
        businessId: "27826971599669",
        taskType: "check_feed_status",
        taskParam: { upload_id: "amazon-upload-1", skus: [] },
      })
    ).toThrow("skus 必须是非空数组")

    expect(() =>
      buildProductPublishRpaRequest({
        businessId: "27826971599669",
        taskType: "check_feed_status",
        taskParam: { upload_id: "amazon-upload-1", skus: ["SKU-001", " SKU-001 "] },
      })
    ).toThrow("SKU 重复")
  })
})
