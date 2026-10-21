# 国内版业务模型接入

适用范围：Listing 生成/优化/打分/文档提取、一键上架复用的 Listing 流程、竞品分析、新品推广、智能定价。

## 前端选择模型

`GET /api/business-ai/models`（Bearer JWT）返回 `{ items: [{ publicId, displayName }] }`。
目录和提交校验使用同一规则：仅 `qwen3.8-max`、`MiniMax-M3`，且 `AiGatewayModel` 中 `category=TEXT`、`modality=TEXT`、`enabled=true`、`gatewayActive=true`。
目录按 `sortOrder`、`id` 排序，不自动指定或替换用户选择。现有通用 `/api/ai-models` 接口保持原样。

各调用仍使用原接口和字段：

- `/api/listing/ai/complete`、`/api/listing/ai/stream`：`model` 必传。
- `/api/listing/documents/analyze`：`model` 必传。
- `/api/listing/generations`：`main.model` 必传；提供 `longTitle` 时 `longTitle.model` 必传。
- `/api/listing/generations/:attemptId/result`：提供 `autoScore` 时 `autoScore.model` 必传。
- `/api/competitor-analysis/analyze`、`profile`、`traffic`、`price-promo`、`summary`：`model` 必传。
- `/api/promotion-plan/ai/complete`、`stream` 与 `/api/smart-pricing/ai/complete`、`stream`：`model` 必传。

上传凭证、历史读取、结果归档没有新增模型选择要求。原角色/业务权限控制保留。
漏传、旧模型或模型未启用返回中文 400，不回退到默认模型；队列任务真正调用网关前再次查库，已停用模型不会继续发起请求。
历史展示及已有输出的结算逻辑不修改，也不会将历史模型名称改成国产模型。

## 网关兼容

`DomesticBusinessGateway` 仅由上述模块显式注入，全局 `AiGatewayProvider` 和其他模块不变。
Qwen 保留原参数及 JSON 解析；MiniMax 采用固定温度 1，不发送不支持的输出长度参数和原生 JSON 模式。
MiniMax JSON 使用提示词、解析和结构校验，保留原重试次数；重试累计真实账单与 token，连接异常不重发、不换模型。
扫描 PDF 在本地转 PNG 页图后交给所选模型，不再把 PDF URL 当作图片发送。
固定模块积分、请求幂等、输出恢复及历史归档口径保持原逻辑。

## 数据与部署

不新增表，不修改 schema，也不自动启停数据库模型。
运行环境需启用 TEXT 分类的目标模型，并保证网关对应上游通道可调用。
依赖仍使用锁文件中的私有 SDK 0.14.0；正常安装需要具备 GitHub Packages 读取权限的 `PACKAGES_TOKEN`。
