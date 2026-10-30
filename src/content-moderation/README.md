# 内容安全审核

所有 HTTP 业务内容参数先通过审核，才进入控制器的业务处理。使用原鉴权、DTO whitelist/transform 校验后再审核；密码、验证码、Token、签名、ID、分页、模型标识及已声明的枚举等技术参数不送审。身份接口的手机号、邮箱作为技术凭证排除，注册展示名和客户资料中的联系方式仍属于业务内容。

不新增审核表、Redis 或审核队列。视频任务复用 `VideoTask`、`BeautyTask`、`StoryboardVideo`；其他接口（包括文本/图片生成入口）在原请求中完成前置校验。没有异步承载的接口含视频/文档时，最多等待审核结果 90 秒，不含文件快照准备时间；超时返回 `408 MODERATION_PENDING`，原业务不执行，由调用方重试。

## 配置及上线

必需凭证沿用现有配置，不要填写示例值：

```dotenv
ZQ_ACCESS_KEY_ID=实际阿里云AccessKeyID
ZQ_ACCESS_KEY_SECRET=实际阿里云AccessKeySecret
```

文件快照复用现有 Spaces 配置与权限（读写、签名下载及清理）；审核文件使用私有 ACL，绝不转为公开对象。阿里云需开通内容安全增强版，RAM 需具备对应审核权限；本实现不依赖 AI 安全护栏产品。控制台决定检测维度、规则、词库及阈值；后端不维护敏感词或维度清单。

| 可选环境变量 | 默认行为 |
| --- | --- |
| `CONTENT_MODERATION_REGION` | `cn-shanghai` |
| `CONTENT_MODERATION_TEXT_SERVICE` | `ugc_moderation_byllm`，`TextModerationPlus`（单次 2000 字） |
| `CONTENT_MODERATION_IMAGE_SERVICE` | `postImageCheckByVL`（大小模型融合图片审核），`ImageModeration` |
| `CONTENT_MODERATION_VIDEO_SERVICE` | `videoDetection`，`VideoModeration` / `VideoModerationResult` |
| `CONTENT_MODERATION_DOCUMENT_SERVICE` | `document_detection`，`FileModeration` / `DescribeFileModerationResult` |
| `CONTENT_MODERATION_ALLOWED_ORIGINS` | 从 `SPACES_BASE_URL`、`OSS_BASE_URL`、Spaces 私有下载域名推导；显式配置时为逗号分隔的 HTTPS origin 白名单 |
| `CONTENT_MODERATION_PASS_RISK_LEVELS` | 四类内容均默认仅原始 `none` 放行；JSON 对象按实际 Service 覆盖指定项，其余保持默认 |

Service 标识具体审核场景，检测标签、词库和阈值在对应 Service 的控制台规则中配置。文本参数为 `content`，图片参数为单个 `imageUrl`；无需配置护栏产品的 `query_security_check` 或 `img_query_security_check`。切换 Service 前核实动作和响应协议；未知等级及缺字段均不放行。

其他环境部署顺序：`npx prisma db push` → `npx prisma generate` → `npm run build` → 按原部署流程重启。仅在已有三个任务表增加可空字段及索引，无迁移文件。配置变更后需要重启进程；不要因阿里云失败关闭审核或默认通过。

## 执行与恢复

1. 普通接口审核自由文本、嵌套业务内容、图片/视频/文档 URL 以及 multipart 文件。文本按最多 2000 个 Unicode 字符分片，相邻片保留 200 字符重叠；分片无法保证跨长距离上下文的语义检测，准确性仍受供应商能力限制。文件大小和格式能力以阿里云服务为准。
2. 有明确文件类型的 URL 必须属于可信存储，不允许 HTTP、IP、用户口令或重定向。无后缀的存储文件按 MIME 补充类型；无文件提示的外部网页链接仅按文字审核，不抓取网页正文。
3. 普通资料接口保留原素材 URL。曦灵形象训练必须提供已有的 `trainingUrl` 字段，`fileId` 改为可选兼容字段；后端对审核通过的视频快照重新上传，避免用安全URL审核、却用另一个fileId训练。仅传fileId的旧客户端需补充trainingUrl。AI Gateway、国产业务模型适配器及 Google 在调用模型前再次核对实际输入；模型媒体与视频任务使用服务端私有文件快照，审核和调用引用相同文件。存量历史资料不会因上线自动重新审核，使用上述模型入口时会重新核对。
4. 网关视频提交统一受服务层审核闸门保护，包括通用视频、动作复刻、带货成片、VidFlowOS、美妆和客户分镜。审核期间状态 `WAITING_MODERATION`；所有实际输入通过后 CAS 认领并进入原 `GENERATING` 流程，实际首次提交前再进行必要的网关估价、余额预检及生成；已记录提交阶段的恢复沿原幂等键对账，不重复做可能阻塞既有任务关联的余额预检。固定价的本地余额检查可提前执行。
5. 每 10 秒扫描到期任务；背景查询间隔至少 30 秒。单任务详情 GET 主动查询，不受背景间隔限制；客户已有按 ID 查询分镜的轮询接口同步推进对应席位。普通列表不逐项启动审核。状态查询使用 `Cache-Control: no-store`。
6. 查询使用数据库短占用防止并发重复请求；下游提交使用独立占用并复用原网关幂等键。取消/删除、输入摘要变化或结果未明确通过时均不继续。异步审核先落 `SUBMITTING`，提交未知不自动重发；已取得供应商 ID 的查询失败保留状态，后续继续查询。
7. 待审最多恢复查询 23 小时，仍未完成会失败。生成超时从审核通过时间起算，旧任务继续使用原创建时间。私有签名快照有效期 24 小时，临时上传和快照分别在 1 天、2 天后清理。独立音频（含音色克隆）和只有 `asset_id` / `object_key` 的素材引用暂不支持，明确拒绝，不能漏审后生成。

已有关联网关 ID 的历史任务继续原回调与对账。历史 `GENERATING/TIMEOUT` 且没有审核记录、没有网关 ID 的孤儿任务无法证明此前是否已提交，按提交未知失败收敛，不自动重发；需人工核对或新建任务。

2026-10-30 入口复查补齐：主生图、图生图、VidFlowOS 改图、局部重绘显式绑定 Body，multipart `form` JSON 按结构解析；Multer 无原型文件集合逐文件审核。RPA 创作首次派发/重试及商品上架文件在发送影刀前审核实际输入，使用审核过的快照；移除 RPA 输入原文日志。带货预览轮询同时推进待审视频。音色克隆的 Provider 也阻止内部调用绕过独立音频限制。

HTTP 安全回归见 `moderation-http.spec.ts`、`moderation-task-http.spec.ts`：使用真实控制器、全局管道、供应商结果解析和审核状态机；通用视频、VidFlowOS、动作复刻、带货生成保留真实业务服务及网关适配器，数据库/外部 SDK 使用测试替身。图片、美妆、分镜的入口测试断言拒绝时不进入业务创建；三个任务载体另验证拒绝后查询/定时任务不能续跑。覆盖拒绝、不可用、未知结果、异步待审、取消、全部通过后仅提交一次。此测试不连接真实生成供应商、不验证真实鉴权或生产数据库。

控制器的全局参数审核不提供任意动态表名或业务重放。新增供应商、从数据库读取内容后直接发送的新执行器，需要调用共享审核服务；新增持久化异步业务类型需明确登记适配器及恢复入口。

## 任务字段与结果

三个已有表新增 `moderationStatus`、`moderation`、`moderationClaimUntil`、`moderationNextCheckAt`、`moderationPassedAt`。`moderation` 内保存输入摘要、本轮各素材审核状态及供应商回执；输入与实际生成快照绑定，不接受客户端通过标记。

`moderationStatus`：`PENDING / PROCESSING / PASSED / REJECTED / FAILED`。业务结果中新增审核状态及安全摘要 `contentModeration`；内部 JSON、供应商任务 ID、输入原文和并发占用字段由响应拦截器移除。

`suggestion`、`riskLevel`、维度 `type/level/suggestion/labels` 保留原始开放字符串。`pass` 才能作为原生通过依据，`block/watch/mask/review` 停止；未识别建议停止。没有原生建议时不伪造 `pass`。四类内容默认仅原始 `none` 放行，结果矛盾或未知等级停止。文本/图片从 `Data.Result` 提取开放标签及原始风险等级，不返回命中原文、OCR 或辅助证据；不伪造供应商建议，也不在后端维护检测维度清单。`mask` 不代表系统已经生成脱敏产物。

## 公共接口

JWT 本人鉴权；只操作已经登记的业务任务，前端无需额外调用，也无需在通过后第二次提交生成。

- `POST /api/content-moderation/check`：`{"businessType":"VIDEO_TASK","businessTaskId":"123"}`。只允许这两个字段，待审返回 202，其他审核状态返回 200。
- `GET /api/content-moderation/tasks/:businessType/:businessTaskId`：主动核对审核并尝试继续；200。
- `businessType`：`VIDEO_TASK / BEAUTY_TASK / STORYBOARD_VIDEO`，任务 ID 使用十进制正整数字符串。不存在或不属于本人统一 404。

```json
{
  "businessType": "VIDEO_TASK",
  "businessTaskId": "123",
  "moderationRevision": 1,
  "moderationStatus": "PROCESSING",
  "canProceed": false,
  "results": [{"itemKey":"generation.reference_videos.0.url","type":"VIDEO","status":"PROCESSING","result":null}],
  "error": null,
  "refreshError": null
}
```

`canProceed` 仅为展示信息，不是执行凭证；继续函数仍检查任务状态和输入摘要。POST 不会重置失败轮次，失败后的重新提交沿用原业务新任务流程。重复状态查询不会再次创建同一供应商审核；HTTP 业务创建接口的客户端幂等能力沿用原模块，未新增跨请求去重。

原业务轮询调用方式保持，界面可按新增状态展示“审核中”。所有审核失败都不调用下游业务；钱包扣费沿用生成后的原结算链路，阿里云审核本身按供应商用量计费。

接口依据：[文本审核PLUS](https://help.aliyun.com/zh/document_detail/2669858.html)、[图片审核增强版](https://help.aliyun.com/zh/document_detail/2528742.html)、[视频审核](https://help.aliyun.com/zh/document_detail/2505810.html)、[文档审核](https://help.aliyun.com/zh/document_detail/2645012.html)。
