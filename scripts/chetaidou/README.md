# 车泰斗全量上线初始化

统一入口：`npm run chetaidou:init -- <参数>`，脚本为 `scripts/init-chetaidou-production.mjs`。用于车泰斗首次上线的新数据初始化；旧基础初始化、演示导入、独立模型上架和维护入口已合并或移除。

## 全量内容

一次执行初始化：

1. C1S Plus 商品与完整事实卡：结构化硬约束、资料隔离规则、条件规则、单图参考、未知事项和来源文档全文。内部编码沿用 `CS1plus`，用于关联已有资料。
2. 文档资料中的全部 25 张预置母版、25 份已确认拆解，以及新母版缩略图。
3. 两项权限：`tool.ai_creative_studio.chetaidou`、`management.chetaidou`。
4. 五项扣费来源：`chetaidou.breakdown`、`chetaidou.ideation`、`chetaidou.diverge`、`chetaidou.compose`、`chetaidou.image`。
5. 两个指定文本模型及两个指定图片模型；可选为指定已有角色追加授权。
6. 全量导入成功后，按 `--enable` 启用商品。

初始化不扫描历史图片、不迁移旧权限、不替换事实卡、不修改或停用已有模型。不调用生成模型，不创建用户、个人草稿、任务、积分余额或消费流水。用户已确认全部初始化母版及配套拆解，导入时写入 `source=PRESET`、`qualityStatus=CONFIRMED` 和确认人/时间，前端可直接使用，无需逐图 acknowledge。数据包 `breakdownAcceptance` 保存本次确认依据，历史原始底稿状态仍留在审计元数据中。源文档未记录货篮信息的部分保存 null/schemaVersion=0，未知信息不影响已确认状态。用户新上传图片的 AI 拆解成功后直接允许联想，仍记录 AI_UNREVIEWED，无需 acknowledge。

新库直接写入最新核对规则（2026-10-07），数据库事实卡版本从 `1` 开始，无需先执行历史 v1→v2→v3 修复。已完成的一次性开发库事实卡修复脚本及对应测试已删除，正式资料包是新环境初始化的规则来源。规则与开发库已发布 v3 一致：5 条硬约束、3 条资料隔离规则、5 条条件规则、2 条单图参考及 4 条未知事项。原图出现 C1S 字样仅作为观察，不据此自动阻断；产品结构、参数与真实标识仍受保护。来源文档全文保留用于追溯，单图观察及历史提示词不升级为通用硬事实。

## 上线执行

上线后，在本地后端项目根目录连接目标数据库执行。Docker 镜像不包含初始化脚本和资料，部署不会自动运行初始化。

准备条件：

- 本地使用最新代码并安装依赖，先执行 `npm run build`。
- `DATABASE_URL` 指向目标数据库，且已有最新表结构。使用 `npm run db:push` 同步；仓库保留的历史集中 SQL 资料已同步当前 Schema，参考 [统一上线 SQL](../sql/2026-10-08-chetaidou-deployment.sql)，旧建表和增量文件已删除。SQL 适用于已有平台基础表的环境，整份在同一目标库连接执行，遇错停止；临时部署过程需要 CREATE ROUTINE/ALTER ROUTINE/EXECUTE 权限。SQL 包含 9 张业务表（含调整历史 ChetaidouAdjustment）、生图表扩展与索引、当前 `deletedAt`，新建业务表的 159 个字段及 12 个生图扩展/调整字段定义均有中文 `COMMENT`，末尾查询同时显示字段注释，并兼容历史 `chetaidouRemovedAt` 删除标记；不批量确认已有用户上传图。完成后 `npx prisma generate` 再构建。初始化脚本本身不执行 DDL。
- `SPACES_ENDPOINT`、`SPACES_BUCKET`、`SPACES_KEY`、`SPACES_SECRET` 能读写内置原图所在的 `erp-pro` 桶。`SPACES_REGION` 默认 `us-east-1`，可选 CDN 配置为 `SPACES_BASE_URL`。
- 首次新增模型需要 `AI_GATEWAY_BASE_URL`、`AI_GATEWAY_API_KEY`。只读取模型元数据，不调用生成。

**新库首次全量初始化**（将尖括号替换为实际配置）：

```bash
npm run chetaidou:init -- --enable \
  --text-multiplier=<文本售价倍率> \
  --image-multiplier=<图片售价倍率> \
  --dry-run
# 预检通过后，使用相同参数去掉 --dry-run 正式执行
```

两个文本模型及两个图片模型都已配置好时：

```bash
npm run chetaidou:init -- --enable --dry-run
npm run chetaidou:init -- --enable
```

主初始化入口只登记以下两个文本模型，不再需要单独执行文本模型同步，也不需要传 `--text-model`：

- `ZQ-Multimodal-Gemini-3.7-Flash`：Google Gemini 3.7 Flash 多模态理解。
- `ZQ-Multimodal-Gemini-3.8-Flash`：Google Gemini 3.8 Flash 多模态理解。

新建文本模型统一使用 `--text-multiplier` 指定的倍率；已有模型保持原价，若显式倍率与其价格冲突则报错。新环境仅初始化以上两项，不自动删除或停用旧环境的其他模型。

默认同时登记并启用以下两个图片模型，新库默认项为 `gpt-image-2.5-sunburst`：

- `gpt-image-2.5-sunburst`
- `ZQ-Image-1`（Nano Banana 2）

新建图片模型统一使用 `--image-multiplier` 指定的倍率，默认不设固定积分（按量计费）。当前已核验数据库的两项倍率均为 1；新库沿用该价格时传 `--image-multiplier=1`。已有配置保留价格与排序，`ZQ-Image-2` 不在初始化清单中。可选 `--image-model=<publicId>` 替换本次图片模型清单为一个指定模型。

文本和图片分类分别为 `CHETAIDOU_MULTIMODAL`、`CHETAIDOU_IMAGE`，文本分类支持多个可用模型，按用户选择或目录排序默认值解析；图片分类也支持多个可用模型，默认项按 sortOrder/id 升序取首项。首次创建必须指定售价倍率，不猜价格。可选 `--image-credits=<积分/张>` 为本次新建图片模型统一设置固定积分，`0` 表示按量计费。新图片模型需支持参考图编辑并提供请求 Schema。已存在的模型只复用；显式参数与已有价格冲突或模型不可用时，报错交由管理端处理，不覆盖配置。

不传 `--enable` 时，新商品默认关闭，已有商品保持启停状态。传入时，仅在本次清单的母版全部就绪后启用对应商品。

## 可选参数

- `--tool-role=<已有角色code>`、`--admin-role=<已有角色code>`：可重复传多个角色，仅追加车泰斗授权。不创建角色或重置已有授权；未传时需在管理端分配。权限缓存最长 5 分钟。
- `--actor-id=<现有启用用户ID>`：记录实际操作人。默认使用系统审计 ID=0，不关联个人账号；预置图 `ownerId=null`。
- `--allow-origin=https://实际前端域名`：可重复，追加存储桶 GET/HEAD 规则并保留原规则；这是显式指定的存储配置操作。`--check-cors` 只读取跨域配置，但不会取消同一命令的数据初始化；整条命令只读需加 `--dry-run`。不传跨域参数时不访问 CORS 配置。
- `--data=<其他资料目录>`：使用自定义的完整资料。

`--maintenance-only`、`--models-only`、`--replace-facts` 已移除。已有业务数据和模型的后续变更通过管理端完成。

## 内置资料

默认读取 `scripts/chetaidou/preset-data/`，随仓库分发，仅供本地初始化使用：

- `data/catalog.json`：25 张原图真实 URL、对象 key、哈希、尺寸及目录信息。
- `docs/c1splus-library-preparation.md`：完整商品文档，保留原观察与待核实项，不将单图观察当作已验证的全 SKU 事实。
- `facts/cs1plus.json`：已核对的结构化事实卡及来源路径、SHA-256、来源日期、规则日期；不携带数据库 ID、历史版本或修复编号。
- `data/studio/breakdowns/`：25 份拆解底稿。
- `manifest.json`、`upload-report.json`：资料清单、母版及拆解已确认记录与逐图上传校验记录。

`manifest.factCardFile/factCardHash` 指向结构化事实卡并校验其完整内容；事实卡再通过 `provenance.sourcePath/sourceHash` 校验来源文档。缺少必需规则、卡片被修改、文档不匹配或跨 SKU 时，在读图片和写库前停止。旧版仅有文档的包需要重新打包，不能作为完整事实卡初始化。数据库 `contentHash` 按最终结构化规则及文档全文一起计算。

无需素材包或登录 Token。原图 URL 指向 `erp-pro.nyc3.cdn.digitaloceanspaces.com`，路径为 `chetaidou/preset-library/CS1plus/<imageId>/<uuid>.<格式>`；原图沿用上传接口的 public-read ACL，脚本不改变 ACL。初始化复用已上传原图，只为新母版生成私有缩略图，数据库保存对象 key。

脚本使用 Spaces 凭证读回原图，验证哈希、尺寸、类型与拆解来源；仅接受当前配置桶及其 CDN。换桶时需先上传原图并准备对应 URL 清单，不能直接复用旧桶 key。

仅校验资料（不连接数据库或网关，但读取 Spaces）：

```bash
npm run chetaidou:init -- --check-data
```

将来为新的初始化环境重新打包资料时：

```bash
npm run chetaidou:init -- --pack-from=../chetaidou-studio-main \
  --image-urls=/tmp/chetaidou-image-urls.json --data=/tmp/chetaidou-new-data
```

`--image-urls` 是完整 imageId→publicUrl 映射；提供时只打包 JSON 与文档，不复制原图。未提供时复制本地原图。打包仅写指定的本地目录，不初始化数据库，不能覆盖内置目录。目录条目使用 `file` 或 `url` 二选一，不能使用临时上传签名地址。

重新打包会携带结构化事实卡、来源文档及清单哈希；已有 URL 包也可重新打包而无需复制原图。无 `manifest.json` 的原型目录仅在来源文档与内置已核对版本完全一致时沿用内置事实卡；文档变化必须先核对并更新结构化规则及哈希，不自动套用旧规则。

## 重复执行与验证

- 相同事实卡、母版导入键已存在且记录完整时只读复用，不重复创建、不改人工拆解、不重新生成缩略图。
- 不兼容或接管 `proto-demo:*` 旧演示记录；它们不参与初始化，也不会被修改。
- 已有同键内容/归属冲突、事实卡不同或记录残缺时直接报错，不补齐、不迁移、不覆盖。
- 事实卡复用同时核对落库哈希和实际内容，人工改过正文但未更新哈希时也会停止。开发库历史 v3 带迁移审计信息，不能当作新库初始化目标；后续资料变更使用管理端发布。
- 新商品与事实卡在同一事务内创建；每张新母版与其拆解在同一事务内创建。失败不会留下半套数据库记录。
- 全流程不是一个大事务，先前完成的完整记录保留；重跑跳过这些记录，继续创建尚未导入的资料。最后一步 `--enable` 是显式的商品启用操作。
- `--dry-run` 不写数据库、不上传、不修改 CORS；不验证对象存储写权限。
- 完成后检查 `/api/chetaidou/config` 的 `models.ready`、SKU、25 张母版及实际角色权限。资料初始化不代表真实生成链路已验收。

`--check-data` 会读回全部原图，检查 25 张图片的哈希、格式、尺寸和拆解归属，并显示事实卡各类规则数量及内容哈希。上线时应先执行资料检查和目标库 `--dry-run`，再用相同参数去掉 `--dry-run` 正式导入。规则完整表示现有已核对资料全部入库；未知结构保持未知；初始化拆解已确认，可直接使用。

开发验证：`npm run chetaidou:init:test`。`data.mjs`、`database.mjs`、`storage.mjs` 为此入口的内部辅助模块。

## 文本模型目录同步（2026-10-06）

这是模型目录同步，不是全量资料初始化或历史维护。默认只同步上述两个车泰斗文本模型的名称和能力（完整初始化已包含这两个模型登记），displayName 来自网关查询。

```bash
node --env-file-if-exists=.env scripts/sync-chetaidou-text-models.mjs --enable --multiplier=1 --dry-run
node --env-file-if-exists=.env scripts/sync-chetaidou-text-models.mjs --enable --multiplier=1
```

新增模型必须显式传售价倍率，1 为项目 TEXT 默认倍率；已有记录的价格和排序不覆盖。只有明确传 --enable 才启用已有记录。该脚本不调用内容生成接口。

仅追加或同步 Gemini 3.7 Flash 联想可选项：

```bash
node --env-file-if-exists=.env scripts/sync-chetaidou-text-models.mjs --model=ZQ-Multimodal-Gemini-3.7-Flash --enable --multiplier=1 --dry-run
node --env-file-if-exists=.env scripts/sync-chetaidou-text-models.mjs --model=ZQ-Multimodal-Gemini-3.7-Flash --enable --multiplier=1
```

`--model` 只操作指定模型；新增项排在现有文本目录之后，保留现有默认项和其他模型启停。前端沿用 `GET /api/ai-models?modality=TEXT&category=CHETAIDOU_MULTIMODAL` 获取选项，草稿 `settings.model` 传对应 publicId。新调用使用 JSON mode，旧调用请求保持冻结。

## 图片模型目录追加（2026-10-12）

NanoBanana2 开放通道的准确 publicId 为 `ZQ-Image-1`；支持参考图编辑，当前 requestSchema v4 仅支持 standard 质量。新增选项使用元数据登记，不停用已有默认模型：

```bash
node --env-file-if-exists=.env scripts/sync-chetaidou-image-model.mjs
node --env-file-if-exists=.env scripts/sync-chetaidou-image-model.mjs --apply --enable
```

默认仅预览。新项排在已有目录后面，价格使用既有数据库默认值（倍率 1、固定积分 null）；已有行保留价格、启停和排序。重复执行不自动启用被用户停用的行。只读取模型详情与 Schema，不调用生图。目录响应为 ZQ-Image-1 添加 recommended=true，推荐标记不改变默认排序。

旧 `switch-chetaidou-image-model.ts` 现为追加可选项，保留其他启用模型；仅恢复目标行，不覆盖其他模型的后续调整。新参数与工作区接入见 `src/chetaidou/README.workflow-optimization.integration.md`。

## 流程优化增量 SQL 交付（2026-10-12）

已有车泰斗基础表时，用户自行执行 [流程优化增量 SQL](../sql/2026-10-12-chetaidou-workflow-optimization.sql)。先选中目标库，同一连接完整执行；可重复执行，仅新增一张历史表、六个字段和四个索引，不做业务回填或价格调整。执行后 `npm run generate`、`npm run build` 并部署，不需重复 db:push。全新平台的首次初始化仍按前文完成基础结构和资料安装。

按用户本轮要求，正式前端联调和真实生图不执行，交付文档与 SQL；SQL 的实际目标库执行由用户负责。

## 露营母版历史误报修复（2026-10-13）

内置 `img-6-1` 底稿已移除人数和 Logo 两条历史提示词误报。已有环境单独执行以下命令；初始化仍不维护存量记录：

```bash
node --env-file-if-exists=.env scripts/fix-chetaidou-camping-conflicts.mjs --dry-run
node --env-file-if-exists=.env scripts/fix-chetaidou-camping-conflicts.mjs
```

按 CS1plus 和图片哈希定位预置母版，仅删除当前拆解中两条完全匹配的误报，保留其他冲突及待核实信息。事务内追加修正版并切换当前指针，保留旧稿作审计；重复执行不新增版本。拆解内容哈希改变后，该母版已有联想和组合按原有过期规则重新生成。
