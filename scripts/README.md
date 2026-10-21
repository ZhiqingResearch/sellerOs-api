# scripts 脚本说明

一次性迁移/修复、数据导入导出、运维工具脚本的用途速查。

**通用约定**

- 运行方式：`npx tsx scripts/xxx.ts`（新脚本）或 `npx ts-node scripts/xxx.ts`（老脚本注释里的写法，实际都能跑）
- **例外**：少数 import 了 Nest 服务的脚本必须 `TS_NODE_TRANSPILE_ONLY=true npx ts-node -r tsconfig-paths/register`（tsx 不支持装饰器元数据），下文已逐个标注
- 标注「幂等」= 可重复执行不会重复生效；「--dry-run」= 先跑一遍只看影响范围不写库
- 连的是哪个库看当前 `.env` 的 `DATABASE_URL`，**跑生产前务必确认环境并先 dry-run**

## 会员 / 积分 / 团队 / 分销

| 脚本 | 作用 |
|------|------|
| `init-chetaidou-production.mjs` | 车泰斗上线完整数据初始化：商品文档事实卡、全量已确认预置母版及拆解、两项权限与五项扣费来源、可选模型上架及角色授权；支持预览、续跑、校验后启用。执行 `npm run chetaidou:init -- --help`，详细说明见 [chetaidou/README.md](chetaidou/README.md)。内置全量资料，无需原型仓库或管理员登录 Token；仅新增初始化资料，不迁移或补齐历史数据。 |
| `migrate-balance-to-credits.ts` | 积分体系上线的一次性迁移：存量用户人民币 balance → RECHARGE 积分批次（×10、永不过期，负余额建负批次记欠账）。幂等（按 sourceRef 跳过），`--dry-run`；前置 db push + 备份 |
| `migrate-lv4-lv5.ts` | 一次性迁移：取消 LV4(FOUNDER)/LV5(INVITER) 特殊计费身份（2026-08-20 新口径），按 subscriptionTier 重算等级，邀请关系/返利参数保留；执行前自动备份受影响行到 `data/lv4-lv5-backup-<ts>.json`。幂等，`--dry-run` |
| `activate-pending-renewals.ts` | 一次性迁移：2026-08-25「续费立即生效」改版前遗留的 ScheduledPlan 排队单全部立即激活（个人顺延+到账+切档、团队顺延+池入账+重算 grace/dataKeep）。幂等，`--dry-run`；**必须 ts-node 方式跑**（import Nest 服务） |
| `backfill-invite-relations.ts` | 一次性回填（LV4/LV5 邀请体系初建，2026-07）：按生产名单（`data/invite-relations.data.ts`，仅按手机号匹配）设邀请人 LV5、被邀请人 LV4，与 InviteService 同口径。幂等，`--dry-run`；前置 db push + 先跑 migrate-balance-to-credits |
| `reassign-invite-relations-20260702.ts` | 邀请关系一次性修正：指定用户从原邀请人解绑升级为邀请人并迁下级。名单在 `data/invite-relations.data.ts`，单事务+逐人校验。幂等，`--dry-run` |
| `reassign-invite-relations-20260724.ts` | 邀请关系一次性修正：指定用户升 LV5、多状态用户统一迁为其 LV4 下级（含 LV5 降级保护校验）。幂等，`--dry-run` |
| `reassign-invite-relations-20260804.ts` | 邀请关系一次性修正：批量 LV4 升 LV5 + 迁移到已有 LV5 名下。幂等，`--dry-run` |
| `backfill-sub-invite.ts` | 邀请权「读时派生→落库制」迁移（2026-09-01）：把开着 subInviteAllowed 的根分销的直接下级批量落库 canInvite=true + 发 24h 邀请码（人工关过的跳过）。幂等，`--dry-run` |
| `backfill-rebate-team-id.ts` | 存量池段返利 REBATE_IN 行补 teamId（2026-09-01 分销树「企业池返利卷起到管理员节点」配套回填）；±5s 窗口匹配 TEAM_CONSUME 行识别，多企业歧义跳过。幂等，`--dry-run` |
| `migrate-invitees-to-team.ts` | 邀请关系→企业团队迁移（2026-09-02 产品口径）：给每个邀请人建 CUSTOM 企业、被邀请人拉为成员（四条跳过规则），管理员个人 RECHARGE 存量注入共享池。`--phone` 单个 / `--all` 全量，`--dry-run` 出报告，幂等可重跑（含自愈补注入）；TEAM_DAYS 环境变量 |
| `backfill-team-member-subscription.ts` | 清占用中企业（ACTIVE/GRACE）成员残留的个人订阅字段（tier/level/有效期）——「加入企业即终止个人订阅身份」（2026-08-26）上线前入队成员的存量修复。幂等，`--dry-run` |
| `backfill-team-names.ts` | 存量空名团队回填默认名「{管理员用户名}的团队」。幂等，`--dry-run` |
| `backfill-team-name-filled.ts` | 存量团队回填 nameFilled 标记（企业名是否显式设置过；非默认名 false→true 单向翻转）。幂等，`--dry-run` |
| `backfill-usagelog-credits.ts` | 一次性回填历史 UsageLog.credits（=cost×10 向上取整），修积分看板老数据恒 0。幂等（只动 credits IS NULL），`--dry-run` |
| `backfill-transaction-invoke-type.ts` | 存量积分流水回填 invokeType=API（CreditTransaction「调用方式」列，2026-09-11 新增）：meta 含 appId 的开放平台扣费行 PLATFORM→API 单向订正。幂等，`--dry-run` |
| `fix-p2t-receipt-snapshots.ts` | 存量修复 2026-08-28 两个收据 bug：PERSONAL_TO_TEAM 订单 creditsTotal 漏算返还积分（重算订单+收据 totalCredits）、0 元单收据 channelLabel 改「——」。幂等，`--dry-run`；**ts-node 方式跑** |
| `fix-teamplan-inject.ts` | 一次性修复（2026-08-29 QA 回归10）：TEAM_PLAN packChoice=inject 未生效期间滞留个人户的 RECHARGE 批次按单补注入企业共享池。需 `--user/--team/--order` 三参数，幂等，`--dry-run` |
| `restore-grace-team-lots.ts` | 存量修复 2026-08-29 生命周期 bug：每日过期任务误回收 GRACE 团队套餐/赠送批次的恢复（remaining 回写+ACTIVE+MANUAL_ADJUST 补偿流水）。幂等，`--dry-run`；**ts-node 方式跑** |
| `create-custom-team.ts` | 平台定制开通企业（不走订单/支付，联调/线下合同客户用）；默认给 18888888888 开「内部测试企业」（10 席/365 天/池 50000 套餐+20000 充值积分），TEAM_* 环境变量可覆盖。幂等；**必须 ts-node 方式跑** |
| `create-internal-account.ts` | 创建菜单/路由配置专用内部账号（默认 18888888888 / OS0911，绑内置超管 ADMIN）。幂等，`--reset-password` 才重置密码，PHONE/PASSWORD 环境变量覆盖；前置先跑 seed |
| `create-open-api-app.ts` | OpenApiApp 接入方管理：创建生成 appId/appSecret（secret 只打印一次）、`--disable <appId>` 停用、`--list` 列表。`npx ts-node scripts/create-open-api-app.ts <名> [单笔上限元]` |
| `seed-distribution-permissions.ts` | 一次性补两个分销菜单权限键（management.distribution / tool.distribution）并绑到内置 ADMIN 角色；只补缺不覆盖（替代全量 seed 防回写运营手调配置）。幂等，`--dry-run` |
| `set-internal-ops-balance.ts` | 把「运营专员（内部）」（OPS_SPECIALIST 角色）用户总额度统一调为 10000。默认 dry-run，`--apply` 写库，`--include-inactive` 含停用账号。属旧 balance 体系时代的工具 |
| `export-usage-log.ts` | 导出指定用户 UsageLog 到 Excel：`npx ts-node scripts/export-usage-log.ts [userId]`（默认 36）；来源中文映射复用 `src/usage/usage-source-labels.ts` |

## 一键上架（product-publish）

| 脚本 | 作用 |
|------|------|
| `import-product-publish-classifications.ts` | 分类 JSON（code/name/sortOrder）导入全局分类目录并补齐全部店铺的分类映射。默认 DRY-RUN，`--apply` 写库。`npm run import:product-publish-classifications -- <json> [--apply]` |
| `product-publish-classifications.initial.json` | 数据文件（非脚本）：一键上架初始分类目录（62 行 code/name/sortOrder），配合 import 脚本做首次导入 |
| `normalize-product-publish-classifications.ts` | 历史分类码下划线→空格的数据修正（兼容无分隔符旧码，同店新旧码并存时合并模板数据）。默认只检查，`--apply` 写库，幂等；`--restore` 可反向恢复 |
| `normalize-product-publish-classifications.sql` | 同一修正的纯 SQL 版（8 个分类码 UPDATE，事务包裹，幂等），Node 脚本之后跑兜底 |
| `export-product-publish-store-classifications.ts` | 导出店铺→分类映射 JSON（仅 externalStoreId/classification 两字段，给 RPA 同事）；分类码残留下划线会直接失败。`npm run export:product-publish-store-classifications [-- --output 路径]` |
| `sync-product-publish-stores.ts` | 店铺初始化同步：补初始分类后从飞书多维表格同步店铺及分类映射（MANUAL 触发），并做首同步验收（SUCCESS 且 total>0 且 skipped=0 否则非零退出）。`npm run sync:product-publish-stores` |
| `sync-product-publish-templates.ts` | 一次性强制同步全部启用 Amazon 店铺的全部分类模板（上传 download_listing 参数文件、调起影刀 RPA、等回调写 templateUrl，逐条串行）。前置：店铺映射已初始化、正式后端回调在线、X-API-Key 一致；`--wait-seconds`（默认 4200s） |
| `upload-product-publish-templates.mjs` | 把 `temp/20260722一键上架功能/templates/` 的 .xlsm 模板按「模版映射说明.txt」两两一组上传到 DigitalOcean Spaces（S3 SDK，key 前缀 product-publish/templates）。`--dry-run` 只校验，需 SPACES_* 环境变量。`npm run upload:product-publish-templates`（ESM） |

## AI Gateway / 模型目录

| 脚本 | 作用 |
|------|------|
| `onboard-ai-gateway-video-model.ts` | 新视频模型上架：按 publicId+category upsert AiGatewayModel 目录行（拉网关 detail/requestSchema 快照，enabled=true）。`npx tsx scripts/onboard-ai-gateway-video-model.ts --publicId=xxx --category=NORMAL [--sortOrder] [--priceMultiplier]`；需 AI_GATEWAY_BASE_URL/API_KEY；下架靠人工置 enabled=false |
| `sync-ai-gateway-video-models.ts` | 刷新本地已有视频模型目录行的快照（displayName/gatewayConfig/quoteConfig）；只 update 不 create，网关 404 的置 gatewayActive=false。`npm run sync:ai-gateway-video-models` |
| `sync-ai-gateway-models.ts` | 统一刷新本地已有 视频/图片/文本 模型目录行快照（displayName/execMode/gatewayConfig，图片&文本另刷 quoteConfig；视频价格动态计算不覆盖 quoteConfig）；只 update 不 create，网关 404 置 gatewayActive=false，modality 不符跳过。`npm run sync:ai-gateway-models`（缺省全部）/ `-- --modality=video\|image\|text\|all`（支持中文别名 视频/图像/图片/文本 及逗号·顿号多选）/ `-- --publicId=xxx` 单独同步某一行 / `-- --dry-run` 预览不写库；需 AI_GATEWAY_BASE_URL/API_KEY |
| `sync-ai-split-models.ts` | AI 拆图模型目录同步：固定同步分析模型 ZQ-Multimodal-Gemini-3.1-Pro（AI_SPLIT_MULTIMODAL 类），命令行参数追加的图片模型 publicId 逐个 upsert 为 AI_SPLIT 类（带 modality/execMode 校验）。`npm run sync:ai-split-models -- <publicId...>` |
| `smoke-ai-split.cjs` | AI 拆图端到端冒烟（CommonJS，直接 `node` 跑）：签 JWT→建测试项目→填商品档案→传 SKU/竞品图→提交 ai-split 任务→按正式签名协议（HMAC）模拟网关终态 webhook→轮询结果。大量 AI_SPLIT_SMOKE_* 环境变量可配；需本地库 + 运行中的 API + 回调密钥 |

## 曦灵（百度数字人）

| 脚本 | 作用 |
|------|------|
| `list-xiling.ts` | 列出当前 XILING_APP_ID 下全部形象/音色（分页全量拉取打印）。`npx ts-node scripts/list-xiling.ts [avatar\|voice]` |
| `query-xiling.ts` | 曦灵只读查询，打印百度返回的完整 JSON 不写库。`npx ts-node scripts/query-xiling.ts <avatar\|voice\|video> <id>` |
| `reconcile-xiling.ts` | 曦灵任务手工对账修复（webhook 被挡 401 数据卡住时用）：从百度拉状态回写 DB；支持 `<figureId\|perId\|all>`，DB 查无记录时传 customerId 可补插新行。`npx ts-node scripts/reconcile-xiling.ts avatar\|voice\|video <id\|all> [customerId]` |

## 数据导入 / 清理 / 运维

| 脚本 | 作用 |
|------|------|
| `import-prompt-templates.ts` | 一次性导入产品提供的 Excel 提示词集合到 ImagePromptTemplate 表（A 维度/B 功能名/C 提示词，按 (dimension,name) upsert，admin 手关的 enabled 不恢复）。默认 DRY-RUN，`--apply` 写库，`npx ts-node ... <xlsx-path>` |
| `import-sensitive-words.ts` | 敏感词初始数据导入（亚马逊/沃尔玛两份 Excel → platform 区分，风险等级映射，createMany+skipDuplicates）。幂等，`--dry-run`；数据源 Excel 放在 `scripts/data/` 下（需自备） |
| `split-industry-tags.ts` | 一次性清理：Tag 表 INDUSTRY 类下含「、/，」的多值标签拆成单值行并删原行。默认 DRY-RUN，`--apply` 执行 |
| `backup-prisma-migrations.ts` | 备份 `_prisma_migrations` 元数据表到 `backups/_prisma_migrations-<env>-<ts>.json`；只读，可带 env 标签参数 |
| `repair-dev-migrations.ts` | 对齐 dev 库 `_prisma_migrations` 与本地 prisma/migrations 的 checksum/孤儿行（历史手动 SQL 残留）。默认 DRY-RUN，`--apply` 执行、`--clean-rb` 顺带删 rolled_back 行；**严禁对 prod 运行** |
| `test-mail-attachment.ts` | 收据 PDF 附件通道一次性验证：用真实 AK 走 MailProvider.sendMailWithAttachment 发一封带最小合法 PDF 的测试邮件。`npx ts-node scripts/test-mail-attachment.ts <收件邮箱>`，需 ZQ_ACCESS_KEY_*/MAIL_FROM 等 .env 配置 |

## scripts/data/（纯数据目录，未被 git 跟踪）

| 文件 | 作用 |
|------|------|
| `invite-relations.data.ts` | 邀请关系生产真实名单 + 类型定义，是 backfill-invite-relations.ts 和三个 reassign-invite-relations-*.ts 的数据源；只按手机号匹配，姓名仅供日志核对 |
| `lv4-lv5-backup-*.json` | migrate-lv4-lv5.ts 正式执行时自动导出的受影响用户行备份（两个时间点的快照），用于迁移出问题时的回查依据 |


## 车泰斗（统一入口）

只使用 `npm run chetaidou:init -- --enable`，先加 `--dry-run` 预检。默认内置 25 张原图 URL/key、已核对的结构化事实卡及来源文档全文和拆解，登记权限/扣费来源并为新母版生成缩略图，不迁移旧权限、不扫描历史图片。无需上传素材包或指定用户，默认审计 ID=0（系统初始化）。图片仍需访问 `erp-pro` 桶。

模型配置、角色授权及可选跨域域名均使用同一入口参数；仅用于全量初始化，支持 `--dry-run`；不替换事实卡或已有模型，后续变更走管理端。旧基础初始化、演示导入、独立模型上架和维护入口已删除。完整命令见 [车泰斗初始化说明](chetaidou/README.md)。
