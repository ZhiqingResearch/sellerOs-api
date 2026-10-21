// scripts/pull-gateway-image-models.cjs
//
// 轨道 B(U1):拉取 AI Gateway 开放的 IMAGE 模型目录,产出 9 槽位映射表的
// 事实依据。用法:
//
//   AI_GATEWAY_API_KEY=<key> node scripts/pull-gateway-image-models.cjs
//   # 可选 AI_GATEWAY_BASE_URL,默认 dev 网关
//
// 输出:每个 IMAGE 模型的 id / 展示名 / 执行模式 / operations,以及对每个
// operation 的请求参数 Schema(aspect_ratio、size、quality、reference_images
// 等是否支持、枚举值是什么)——映射表定稿直接照此填。

const { AiGatewayClient } = require("@zhiqingresearch/ai-ts-sdk");

const DEFAULT_BASE_URL = "https://ai-gateway-api-dev.zhilingtech.com/v1";

async function main() {
  const apiKey = (process.env.AI_GATEWAY_API_KEY || "").trim();
  if (!apiKey) {
    console.error("缺少 AI_GATEWAY_API_KEY(向网关团队/部署环境取)");
    process.exit(1);
  }
  const baseURL =
    (process.env.AI_GATEWAY_BASE_URL || "").trim() || DEFAULT_BASE_URL;

  const client = new AiGatewayClient({ baseURL, apiKey });

  const list = await client.models.list({ modality: "IMAGE" });
  console.log(`IMAGE 模型共 ${list.data.length} 个(${baseURL}):\n`);

  for (const m of list.data) {
    console.log(`## ${m.id}`);
    console.log(`   名称: ${m.display_name}`);
    console.log(`   执行: ${m.exec_mode} | operations: ${m.operations.join(", ")}`);

    // 每个 operation 的请求 Schema —— 映射表的参数翻译依据。
    for (const op of m.operations) {
      try {
        const schema = await client.models.requestSchema(m.id, { operation: op });
        const props = schema.request_schema?.properties ?? {};
        const summary = Object.entries(props)
          .map(([k, v]) => `${k}:${v.type ?? "?"}${v.enum ? `(${v.enum.join("|")})` : ""}`)
          .join("  ");
        console.log(`   [${op}] ${summary}`);
      } catch (e) {
        console.log(`   [${op}] schema 拉取失败: ${e?.message ?? e}`);
      }
    }
    // 定价(计费对账用,U2=CNY amount 口径)。
    try {
      const pricing = await client.models.pricing(m.id);
      console.log(`   定价: ${JSON.stringify(pricing).slice(0, 300)}`);
    } catch {
      console.log("   定价: 无");
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error("拉取失败:", e?.message ?? e);
  process.exit(1);
});
