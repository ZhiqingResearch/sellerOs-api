# 预览墙元信息与车泰斗成品操作：前端联调说明

日期：2026-10-14。分支：`lsx/preview-wall-optimization`。

本文描述本分支实现，尚未部署。接口均带 `/api` 前缀；需要用户 Bearer Token。新增车泰斗操作沿用 `tool.ai_creative_studio.chetaidou` 权限。成功响应为下列对象，错误沿用 `{statusCode,message,timestamp}`，车泰斗业务错误可包含 code/details。

## 1. 模型名称与生成信息

统一展示 `displayName`。后端根据记录实际 publicId 查询模型目录，包含停用模型；查不到、名称为空时保留原接口的模型名称。提交仍用模型 ID，不把 displayName 回传为模型 ID。

历史信息缺失时返回 null/缺失，前端不要补默认模型、默认档位、默认时长或模式。清晰度档位是请求意图；像素尺寸是最终文件尺寸，不能取缩略图或当前表单。

| 查询 | 新增或继续使用的字段 |
| --- | --- |
| `/chetaidou/skus/:skuId/results` | 保留 `imageModel`、`generation.resolutionTier/quality`、逐图 `width/height/generationMeta`；新增 `displayName/intent/sourceResultId` |
| `/chetaidou/tasks/:taskId` 及任务列表/批量状态 | 顶层 `displayName/intent/sourceResultId`；保留 `executionSettings.imageModel`、`generation` 和逐图尺寸 |
| `/image-project/tasks`、`/image-project/task/:taskId` | 新增 `modelPublicId/displayName/resolutionTier`；保留逐图 `width/height/nativeWidth/nativeHeight/deliveryMeta` |
| AI 拆图现有任务组查询 | 逐结果与逐任务补 `modelPublicId/displayName/resolutionTier`，任务补 `deliveryPlan`；逐图仍取自身宽高 |
| 文生图、批量改图现有 Job 轮询 | 成功结果补逐图 `width/height`；文生图成功响应、改图 Job 顶层补 `modelPublicId/displayName/resolutionTier` |
| `/video-project/tasks`、`/video-project/task/:taskId`、项目详情/创建/取消结果 | 保留 `publicId/displayName/mode/durationSec/resolution`；补明确请求/实际值 |
| `/video-project/sales/:projectId` | 每个 `outputs[].videos[]` 新增 `mode` 及明确请求/实际值；名称来自各自模型 |
| `/beauty-project/tasks`、`/beauty-project/task/:taskId` | 新增 `publicId/displayName/mode` 及明确请求/实际值 |
| `/rpa-creation/tasks`、`/rpa-creation/task/:id` | 新增 `displayName/requestedDurationSec/requestedResolution`；图片 `outputs[]` 新增 `width/height`；历史空 resolution 不再补 720p |
| 客户工作台素材图片/分镜查询 | 逐 variant/video 返回 `modelPublicId/displayName`；图片返回 `resolutionTier/width/height`，视频返回 mode 和明确请求/实际值 |
| `/customer/project/:projectId` 的 `production.scripts[]` | 新增 `mode/modelPublicId/displayName/actualDurationSec/requestedWidth/requestedHeight`；`videoDuration` 仍为毫秒 |

视频新增字段：

```json
{
  "requestedDurationSec": 10,
  "requestedResolution": "1080p",
  "actualDurationSec": 8,
  "actualResolution": "720p"
}
```

实际值有可靠回执/文件探测时才填。旧 `durationSec/resolution` 保留原兼容行为，不应继续当成区分请求与实际的依据。前端优先显示实际值，只有请求值则标“请求”；自动时长不展示 0/-1 秒。

模式映射：`NORMAL=常规`、`REFERENCE=全能参考`、`MOTION_CONTROL=动作控制`；美妆 `reference_to_video=参考生成`；RPA 沿用 `inputMode=INGREDIENTS` 展示“素材模式”；`DIGITAL_HUMAN=数字人合成`。缺少历史模式时不取当前表单补造。

图片尺寸兼容网关 `metadata.delivery.final_size/source_size`：前者为网关成品尺寸，后者为模型源图尺寸。本地再裁剪/缩放时，以本地交付尺寸为准；已有记录列为空但已存该元数据时，查询补齐返回，不写回数据库、不重新生图。

图片创作的普通生图及文生图/改图执行器：网关缺少宽高且本地交付处理未提供尺寸时，从最终托管文件读取实际宽高，保存到逐图 `width/height`。探测失败保留成功图片，不用请求尺寸补造；本兜底不回填历史记录。

图片示例：`displayName · 请求 2K · width×height`。`quality=standard/hd` 单独展示。降档/裁剪说明取该图原有交付元信息。

## 2. 局部重绘

```http
POST /api/chetaidou/results/:resultId/inpaint
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

multipart：`form` 为 JSON 字符串；`annotatedImage` 为一张完整成品上的编号标注 PNG；可选 `references` 为参考图片文件，按提交顺序从 1 编号。

```json
{
  "idempotencyKey": "b9be0889-6c64-4c61-8d72-2ca6c36b1298",
  "sourceWidth": 1536,
  "sourceHeight": 2048,
  "prompt": "保留商品和文字，只修改背景",
  "imageModel": "ZQ-Image-2",
  "annotatedBoxes": [
    {
      "n": 1,
      "x": 0.1,
      "y": 0.15,
      "w": 0.3,
      "h": 0.25,
      "instruction": "换成浅灰色墙面",
      "refImageNumbers": []
    }
  ]
}
```

- resultId 取墙内成品 ID；不传源 URL/key/source，不编辑原母版。
- idempotencyKey 是 UUID；网络重发保持同一键和同一输入。有意再编辑使用新键。
- sourceWidth/sourceHeight 和标注图尺寸必须匹配当前成品。冲突返回 409、`EDIT_SOURCE_MISMATCH`，重新加载后调整标注。
- 至少一个框；坐标有限且归一化，`x/y>=0`、`w/h>0`、`x+w<=1`、`y+h<=1`；n 为唯一正整数；instruction 非空且最多 1000 字。
- prompt 可省略或为空，最多 1000 字；imageModel 可省略，使用来源模型。显式值必须是车泰斗可用图片模型的 publicId，停用/不支持编辑时拒绝，不自动换模型。
- reference 编号从 1 起，不含源图/标注图；无参考图时传空数组或省略。参考图支持 JPEG/PNG/WebP，排除动画/多页；总参考数量按所选模型 schema 校验，无新增任意业务限额。
- 模型输入顺序固定：干净成品、标注图、参考图。不混入原组合提示词；当前草稿或组合变化不会阻止成品编辑。
- 一次一张，正常生图结算；此能力为矩形标注提示式编辑，不承诺框外像素逐像素不变。

HTTP 202：

```json
{
  "taskId": "00a670fd-abfe-499f-b6b6-ce4d07a0dc3a",
  "status": "QUEUED",
  "intent": "INPAINT",
  "imageGenJobId": "e4243faa-4666-4aa6-a839-122db2103158",
  "sourceResultId": 310,
  "items": [{ "resultId": 502, "index": 1, "status": "QUEUED" }]
}
```

沿用现有 taskId 查询、取消和失败重试接口。Task.type 仍为 GENERATE，intent=INPAINT 用于“局部重绘”标签；新结果留在同 SKU 墙，原图不变。重试冻结原成品/标注/模型并复用原 Job；只有失败结果可主动重试，UNKNOWN 不自动重新调用。查询和交付恢复不重复收费。

## 3. 加入模板与存入素材池

后端按结果 ID 复制持久文件，前端不下载重传、不保存五分钟签名 URL。副本沿用现有目标库公开 URL；原车泰斗文件仍私有。导入不调用模型、不收费，原图不删除。

### 新建模板

`POST /api/chetaidou/results/:resultId/save-to-template`

```json
{
  "idempotencyKey": "c2e6fe37-293f-49d0-a463-62668515d7f9",
  "mode": "CREATE",
  "name": "车泰斗场景模板",
  "groupName": "商品场景",
  "tags": ["车泰斗"],
  "note": ""
}
```

CREATE 名称必填，最多 200 字；groupName 可省略，最多 50 字，不存在时创建本人分组；note 最多 500 字。APPEND 只传 `idempotencyKey/mode/templateId`，不传新模板名称/分组/tags/note；必须是本人非系统模板。

HTTP 200：`{resultId,templateId,templateItemId}`。后续用已有 `/image-project/templates` 查询，条目包含公开来源 `sourceMeta` 和可确认的档位/比例。内部编译提示词不导出为模板 prompt。

### 素材池

`POST /api/chetaidou/results/:resultId/save-to-material-pool`

```json
{
  "idempotencyKey": "878ac45e-3f0c-497e-bd92-70c45f6a72aa",
  "name": "车泰斗生成图",
  "groupId": 12,
  "tags": ["车泰斗"]
}
```

name 必填，最多 200 字；groupId 省略表示不分组，有值时须为本人分组。

HTTP 200：`{resultId,poolImageId}`。同幂等键同请求重试返回原结果；新幂等键保存同一 resultId，若已在本人素材池且未删除，返回 HTTP 409「已在素材池中」，不新增、不改名或移动分组。目标删除后可用新键再保存。后续用已有 `/material-pool/images` 查询。

两个保存入口：同键同请求返回原结果，同键不同参数/不同动作返回 409。模板不同键允许有意重复追加；素材池按稳定来源去重。没有新增异步导入任务。

## 4. 发布与验证

新增可空 JSON 元信息列及 `ChetaidouResultImport` 表。目标环境先执行 `npm run db:push`、`npx prisma generate`，再发布本分支后端和前端接入。不要执行 migrate；本次开发未同步任何远端数据库。

联调重点：首次完成/刷新名称与参数一致；停用模型和名称未命中回退；裁剪后尺寸；带货各历史版本 mode；数字人口播毫秒/秒；重绘新图入墙和再编辑；同键重发、越权、尺寸冲突；模板新建/追加与素材池分组；五分钟后副本仍可读取和用于生成。

后端测试使用 Mock Provider 与实际小图；真实模型编辑能力、最终图像质量、对象存储访问及目标环境 schema 需要发布后联调验证。
