# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目概述

AI 寻源平台后端 API，基于 NestJS 框架，使用 Prisma ORM + MySQL 数据库，JWT 认证，集成阿里云短信服务和 Gemini AI。所有用户提示信息使用中文。

## 常用命令

```bash
# 开发
npm run start:dev          # 开发服务器（热更新，端口 8000）
npm run build              # 生产构建（nest build → dist/）

# 测试
npm run test               # 运行全部单元测试
npx jest --testPathPattern=product-report  # 运行指定模块测试
npm run test:cov           # 测试覆盖率

# 代码检查
npm run lint               # ESLint 自动修复

# 数据库
npm run db:push           # prisma db push（本项目 schema 同步的唯一方式，不跑 migrate）
npx prisma generate        # Schema 变更后重新生成 Prisma Client
npx tsx prisma/seed.ts     # 初始化种子数据（可带模块参数，如 membership billing models）
```

## 架构

- **全局路由前缀**：`/api`，所有接口路径均以 `/api/...` 开头
- **Swagger 文档**：访问 `/api-docs`，使用 Bearer 认证
- **认证**：JWT + Passport.js（`JwtAuthGuard`）。Token 载荷：`{ sub: number, phone: string, role: string }`。控制器中通过 `@Request() req` → `req.user.id` 获取当前用户
- **参数校验**：全局 `ValidationPipe`，启用 `whitelist` 和 `transform`
- **异常处理**：全局 `AllExceptionsFilter`，返回 `{ statusCode, message, timestamp }`
- **日志**：`LoggerMiddleware` 应用于所有路由，记录请求方法、URL、状态码、耗时

### 模块规范

每个功能模块包含：`module.ts` + `controller.ts` + `service.ts` + `dto/*.dto.ts`

- 控制器：使用 `@UseGuards(JwtAuthGuard)`、`@ApiBearerAuth()`、`@ApiTags()`、`@ApiOperation()` 装饰器
- 服务层：注入 `PrismaService`，使用 `Logger`，抛出 NestJS HTTP 异常
- DTO：使用 `class-validator` 校验装饰器 + `@ApiProperty`/`@ApiPropertyOptional`（含示例值）
- 分页：复用 `src/common/dto/pagination.dto.ts` 中的 `PaginationDto`（page, pageSize，使用 `@Type(() => Number)`）

### 模块一览

| 模块 | 路径 | 说明 |
|------|------|------|
| AuthModule | `src/auth` | 登录注册、JWT 认证 |
| AuthEmailModule | `src/auth-email` | 邮箱认证通道（`/api/auth/email/*`）：开放注册（验证码 + 伪手机号 9 开头占位 + 默认绑「Ops」角色，按 name 精确查、缺失不阻塞仅日志）即登录、邮箱密码登录、找回密码（仅邮箱注册账号）。邮箱账号落 `EmailAccount` 表（email 库级唯一，小写归一），验证码落 `EmailAuthCode` 表（purpose 区分 REGISTER/RESET），与邀请注册的 `EmailCode` 完全隔离；自注册同配置 JwtModule，token 与 `/auth/login` 互通。另含跨域登录交接（`/api/auth/sso/*`）：海外首页登录后 `handoff` 换一次性 60s code（`AuthHandoffCode` 表存 sha256 哈希），Seller 主站 `exchange` 原子核销换 token；后端不构造跳转 URL（无开放重定向面），失败统一 400 防枚举 |
| SmsModule | `src/sms` | 阿里云短信验证码 |
| HistoryModule | `src/history` | 操作历史记录 |
| ProductReportModule | `src/product-report` | 产品报告 |
| SelectedProductModule | `src/selected-product` | 选品管理 |
| CustomerModule | `src/customer` | 客户中心（客户、账号、项目、来源、方案、生产、形象、音色、标签、dashboard） |
| OssModule | `src/oss` | 阿里云 OSS 上传 |
| InspirationRadarModule | `src/inspiration-radar` | 灵感雷达（订阅管理、Apify 抓取、存素材池） |
| MembershipModule | `src/membership` | 会员/积分：钱包、套餐订阅、后台充值、邀请/分销返利、后台分销/个人订阅管理 |
| BillingModule | `src/billing` | 在线收银台：Stripe 三渠道（微信/支付宝/银行卡）下单、webhook 入账、收据 PDF、目录/自定义充值阶梯；人民币计价、Stripe 实时汇率折美元收款（FxService） |
| TeamModule | `src/team` | 企业团队：共享池/配额/成员/生命周期/模型配置（AiModel 目录 + 9 功能模块整页批量保存），自助购买与平台定制两条线；用量分析含已移出/停用成员（2026-08-29 起：已移出按区间内 TEAM_CONSUME 流水找回，各维度与合计同算；member 维度行带结构化 `memberStatus` 字段 ACTIVE/DISABLED/ARCHIVED/REMOVED，label 纯姓名不含后缀，CSV member 维度多一列中文「状态」） |
| UsageModule | `src/usage` | 消费计价与扣费路由（个人/团队/邀请人共享），UsageLog 记录；公共扣费 v2（`POST /usage/deduct/v2` + `chargeModel`：FeatureModule 注册表校验 source、model 必填、双写 UsageLog、requestId 幂等——**并发撞唯一索引整事务回滚不重复扣**（2026-09-01 修复：P2002 不再事务内吞掉，此前并发同键会双扣），事务外重查返回首次结果；`chargeModelInTransaction` 为其事务内核，供已持有外层事务的调用方复用）；AI Gateway 终态扣费（视频/分镜/美妆/图片回调）也走该 v2 内核，source 一律用注册表 key 并按业务入口分流：`video-project.generate`=通用创作+刀哥创作+客户分镜（兜底）、`video-project.sales`=带货成片（salesWorkflowId 锚定）、`video-project.motion`=动作复刻（mode）、`beauty-workflow.generate`、`aicreative.image_generate[.ai_split]`；数字人合成（曦灵）不计费不设 source；requestId=`gateway:{gatewayTaskId}`；网关计费统一乘 `AiGatewayModel.priceMultiplier`（视频 2、图片 3、TEXT 1）——报价 quote、四处提交预检、终态扣费同口径（`safeMultiplier` / `usage.gatewayPriceMultiplier`），扣费 meta 留 `gatewayAmountCny`+`priceMultiplier` 对账；`/usage/token` 落 `meta.model`（显式传 > meta 兼容 > 企业成员回解团队模型配置默认模型），用量分析按模型维度 label 取 AiModel 目录名 |
| OpenApiModule | `src/open-api` | 对外开放接口（`/api/open/credit/*`：deduct/balance/features），其他项目服务间调用，AppId + HMAC-SHA256 签名鉴权（OpenApiApp 表，`scripts/create-open-api-app.ts` 管理接入方）；KeyB 扣费 `POST /api/open/keyb/credit/deduct` 使用 v2 签名绑定凭证/目标/原始载荷，复用 `chargeModel` 与 UsageLog 幂等；项目授权存 `OpenApiApp.keybProjectCodes`，默认空数组，每请求查库，脚本创建时 `--keyb-project selleros` 或对已有服务 `--grant-keyb <appId> selleros` / `--revoke-keyb <appId> selleros`，无需改环境变量或重启，旧手机号接口不受项目授权限制 |
| SkillsKeysModule | `src/skills-keys` | SellerOS 用户 KeyB 管理（`/api/skills/keys` 生成/状态/reset/reveal），JWT 本人操作；后端 KeyA 调 Skills API 签发，AES-256-GCM 加密保存 `SkillsKeyCredential`，ROTATING / SYNC_UNKNOWN 拒绝复制及新扣费，operationId 防重复签发；**2026-09-14：明确 reset 使用当前配置的项目/KeyA/地址，允许旧 ACTIVE 凭证切换项目，自动更新关联；GET 的 SYNC_UNKNOWN + SKILLS_PROJECT_CHANGED 允许用户主动新 UUID 重置，真实签发中/失败状态仍拒绝重签，无需手工迁移数据库**；基础配置仅 `SKILLS_KEYS_API_ORIGIN` / `_PROJECT_ID` / `_PROJECT_KEY_A` / `_ENCRYPTION_KEY` 四项，旧 `_ALLOWED_APP_IDS` 已废弃不参与授权；部署与前端说明见 `docs/SellerOS-KeyB-部署文档.md`、`docs/SellerOS-KeyB-前端对接文档.md` |
| CompetitorAnalysisModule | `src/competitor-analysis` | 竞品分析（模块化请求拆分 + AI 总结，事实数据源 Keepa/SIF/SellerSprite，无库表落存）；Listing AI（`src/listing`）文档分析/属性结构化；两者及新品推广/商品智能定价经智擎 AI 中转站调用，按账单实际 model 读取 `AiGatewayModel.priceMultiplier` 加价后扣积分（复用 `UsageService.gatewayPriceMultiplier`，缺失/非法倍率回落 1；不再硬编码 2.5，需在模型表配置售价倍率） |
| ProvidersModule | `src/common/providers` | 全局 AI Provider（`@Global()`） |
| ChetaidouModule | `src/chetaidou` | 车泰斗 AI 商品素材工作台（`/api/chetaidou/*`，方案见 docs/designs/2026-09-28-chetaidou-material-workbench-backend-implementation-plan.md）：预置母版及配套拆解已确认（PRESET/CONFIRMED，无需 acknowledge）；用户上传拆解（AI_UNREVIEWED 需 acknowledge）→ IDEATION 联想（10–20 维×30–60 选项，逐维独立 Call 失败隔离，修复预算 1 次）→ REFRESH_GROUP 成功维度刷新（新 groupId 不可变版本）→ COMPOSE 组合/冲突问答（输出唯一存根 Task.output，问答新建根任务 parentTaskId 链）→ GENERATE 生图（1/2/4/8 张，复用 ImageGenJob/ImageGenItem + businessType=CHETAIDOU 来源隔离，旧 t2i/i2i runner/对账/清理不碰 CHETAIDOU 行）；ChetaidouCall 逐次调用账本（state PREPARED→SUBMITTING→WAITING/RECEIVED→FINISHED，UNKNOWN 不自动重发）；计费 5 个 source（chetaidou.breakdown/ideation/diverge/compose/image，文本按账单×倍率、图片一口价优先）；webhook 对 `chetaidou:call:` 前缀先落回执（ChetaidouGatewayReceiptService）再由 runner 消费；草稿服务端 CAS（revision 乐观锁，任务指针 activeIdeationTaskId/activeCompositionTaskId/activeGroupRefs）；模型按 AiGatewayModel 分类 CHETAIDOU_MULTIMODAL（拆解/文本）/CHETAIDOU_IMAGE（生图）各取唯一启用行，任务快照冻结 publicId/category，重试与结算使用原调用模型，无模型 env，总开关 CHETAIDOU_ENABLED 默认开启，无需配置，仅显式 false 时关闭；**2026-09-28 用户确认：去除 PRD 未指定的进程调用并发、每用户活动任务数、上传/导入/产物大小与尺寸像素、总选择数、状态查询/分页大小及模型输出额外数组上限，相关限额 env 已删除；保留 PRD 的维度/选项/生图数量、文字限制、修复预算和超时**；完整上线初始化 `npm run chetaidou:init -- --enable`（脚本 `scripts/init-chetaidou-production.mjs`，结构化事实卡及来源全文+已确认母版/拆解（PRESET/CONFIRMED，用户 2026-10-08 确认，无需 acknowledge）+权限/扣费来源，直接DB/Spaces，支持 dry-run/重复执行跳过完整记录；旧底稿缺货篮信息保留 null/schemaVersion=0，不伪造空篮；详见 scripts/chetaidou/README.md）；统一入口内置资料 URL，默认系统审计 ID=0；仅用于新环境全量初始化，整合模型新增、结构化规则与来源全文/25 张母版/25 份拆解及新母版缩略图；2026-10-08 初始化事实卡采用已核对的 SKU 隔离规则，数据包校验卡片与来源哈希，新库版本从 1 开始，不依赖历史修复脚本；不迁移旧权限、不补齐历史数据、不覆盖已有事实卡或模型；旧独立脚本及 `--maintenance-only`/`--models-only`/`--replace-facts` 已移除；前端原型接入层 ../chetaidou-studio-main/public/studio-backend.mjs（契约翻译：状态小写映射、选项 ID `groupId.optionKey`、preserve 文案模式迁移）；轻量调度：Task/Call 不设租约、心跳、落库 deadline 或 nextRunAt，状态 CAS 认领，文本中断待核对不自动重跑；扣费以 Call 行锁 + UsageLog.requestId 唯一键保证幂等，扣费与结算标记同事务；2026-09-29：所有创建/重试入口取消余额预检和开发估价配置，保留模型就绪校验及调用后实际结算 |

车泰斗 2026-09-29 联调修复：C 端权限统一 `tool.ai_creative_studio.chetaidou`；组合指针覆盖当前轮次所有状态（提交事务内设置，执行完成不回填）；发散 ID/来源/历史/应用与放弃复用草稿和 Task.output；联想过期校验及重试根聚合已补齐。前端改动与全量初始化命令见 `src/chetaidou/README.integration.md`，新环境用 `npm run chetaidou:init -- --enable --dry-run` 预览（未配置模型时同时传模型参数），去掉 `--dry-run` 正式执行；初始化不承担历史数据维护，无新增表。

### 全局 Provider（`src/common/providers/`）

第三方服务统一封装为 Provider，通过 `ProvidersModule`（`@Global()`）注册，所有模块可直接注入：

- `GoogleProvider`：统一封装 Google 全系 AI 能力（`@google/genai`）。文本 Gemini 2.5 Flash（`generateText` / `deepSearch`），图片 Nano Banana 2（`generateImage`），视频 Veo 3.1 Lite（`startVideoGeneration` / `pollUntilDone` / `downloadVideo`，时长仅 4/6/8 秒）
- `BaiduXilingProvider`：百度曦灵数字人/音色克隆/视频合成（异步 webhook 回调；并提供 `queryAvatar` / `queryVoiceClone` / `queryVideoTask` 用于对账）
- `ApifyProvider`：Apify 平台集成（灵感雷达），封装 Pinterest / Instagram / TikTok 三平台关键词搜索，同步获取结果并归一化为统一 `ApifyMediaItem` 结构
- `StripeProvider`：Stripe 支付（`stripe` SDK）。PaymentIntent 三渠道：微信（`wechat_pay`，返回 `image_data_url` 二维码）、支付宝（`alipay`，returnUrl 跳转）、银行卡（`card`，clientSecret 供前端 Elements）；webhook 验签在 `StripeWebhookController`
- `MailProvider`：邮件发送（阿里云 DirectMail，与短信同一套 AK）。普通 HTML 邮件走 pop-core `SingleSendMail`；**带附件**（收据 PDF）走官方 `@alicloud/dm20151123` SDK 的 `singleSendMailAdvance`（附件能力只在新版 SDK 提供，裸调 API 不支持；附件发送失败自动降级纯 HTML 无附件）
- `AiGatewayProvider`（`src/common/providers/ai-gateway.provider.ts`）：智擎 AI 中转站封装（OpenAI Chat Completions 兼容，私有 SDK `@zhiqingresearch/ai-ts-sdk`——GitHub Packages 分发，本地/CI/Docker 构建均需 token；workflow 用 GitHub secret `PACKAGES_TOKEN` → BuildKit secret（`env=PACKAGES_TOKEN`）→ `.npmrc` 引用 `${PACKAGES_TOKEN}`；Docker 构建用 `.npmrc` 只读 bind-mount，不落入镜像层）。模型按功能 key 可配（`AI_GATEWAY_LISTING_MODEL`/`_SCORE_MODEL`/`_ASSISTANT_MODEL`，默认 ZQ-Think-Flash），超时默认 300s（`AI_GATEWAY_TIMEOUT_MS`）

### 会员/积分/团队计费（`src/membership`、`src/billing`、`src/team`）

- **等级口径**：只看 `User.subscriptionTier`（1/2/3 → LV1-3），`membershipLevel` 是冗余回写；NONE=普通用户。**LV4/LV5（FOUNDER/INVITER 特殊计费身份）已取消**——邀请只是关系（`invitedById`），不再带来计费特权；老数据迁移用 `scripts/migrate-lv4-lv5.ts`（幂等，先 `--dry-run`）
- **积分台账**：所有变动 = CreditLot 批次 + CreditTransaction 流水（`CreditService.grant/recordRecharge/consume/adjust`）。桶：RECHARGE（充值本金，永不过期）/ PACKAGE（套餐本体，30 天过期）/ GIFT（套餐赠送 + 充值包/自定义充值赠送 + 注册赠送，30 天过期）/ REBATE（返利，独立核算不可消费）。套餐激活/升级把 packageCredits/giftCredits 拆成 PACKAGE+GIFT 两批次（同到期日），充值类走 recordRecharge 多批次一条流水。消费顺序：个人=先赠送层（PACKAGE+GIFT 合池按过期先后 FIFO）后 RECHARGE；**企业成员=三段混合扣减（2026-08-27 起）：个人赠送层 → 企业共享池 → 个人充值**（`consumeRouted` 单入口，全链路通用；配额只记企业段；**SHARED+BLOCK「阻止使用」=阻止企业池不阻止个人（2026-08-29 定稿）：企业段按本月配额剩余封顶、超出落个人充值段，不再整体 400**（INDEPENDENT 独立配额维持硬上限 400；WARN 放行照旧）；透支兜底落个人充值段；余额预检（视频批提交等）与消费同口径=个人可消费+池合计；混合事件流水盖 `meta.consumeEventId` + `ownershipSplit` 事件章供明细双归属/双剩余渲染，列表接口另按事件聚合下发 `eventTotalCredits`（各段合计总额）+ `eventConsumeSources`（全量扣费来源含每来源扣分，按扣减顺序排，2026-08-29 起；行级 amount/consumeSource 仍单段口径），且**列表按展示单元合并返回（2026-08-29 定稿）：一笔事件只出一行、分页/总数按合并后计，代表行=企业段行（teamId 有值，成员/管理员视角都可见；轻量全量扫描 id/teamId/meta 判事件章，无事件章走老路径，CREDIT 方向直查）**，顺序常量 `TEAM_MEMBER_FUNDING_ORDER` 预留可配置；**计价折扣（2026-09-02 定稿）：企业池段按 `Team.discount`（共享池计价折扣——此前从未参与扣费，纯展示字段），个人段（赠送层/充值）按成员「生效折扣」；生效折扣 = `canInvite=false` 且有邀请人 → 沿 `invitedById` 上溯跟随最近一个开过「允许邀请注册」的上级，否则用本人 `discount`（`CreditService.resolveEffectiveDiscount`，消费/企业成员个人段/预检/钱包展示同口径；注册时抄的折扣快照不再是计价依据）；双费率不一致时按成本顺序切段、段内各自取整，企业成员预检按两费率较高者保守估**）。流水 `balanceAfter` 口径：个人行=个人可消费合计，**企业池行（teamId 有值）=池余额**（`recordRecharge` 已按 teamId 分流；新写池流水的路径别再用个人余额）；**动用邀请人额度的行=邀请人池余额，被邀请人视角也直接展示它（2026-09-01 bug13 口径，废 consumerBalanceAfter 覆盖——meta 字段仍写仅作审计快照）**；**额度共享双闸门（2026-09-02 bug28）：邀请人共享额度 = `shareCreditsWithInvitees` + 邀请人 `canInvite` 同时在才生效**——关闭邀请（含批量收回）连带关共享、重开不自动恢复（⚠️ 与 rebateEnabled 口径分叉：返利参与 2026-09-03 bug31 起重开同步恢复，共享仍需重新主动配置），消费（`resolveFundingOwnerIds`）/预检/钱包 `inviterShareCredits` 同口径
- **套餐续费**：续费**立即生效**（2026-08-25 起废排队制，`CreditService.renewImmediateInTx`）——有效期在「当前到期日（已过期则 now）」上顺延一期、PACKAGE+GIFT 两批次立即到账（到期日=新有效期）、立即切档；**存量批次顺延（2026-08-28 起，个人/团队同口径）**：续费前未过期的 RECHARGE_PLAN 来源 PACKAGE/GIFT 批次统一延长到新有效期（充值包本金/注册赠送/充值包赠送/客服补偿不顺延；团队池批次同规则）；**高等级不能续费低等级**（400，个人/团队同规则）；升档立即生效、差价/积分差按剩余天数折算（到期日不变，多次续费后升级=整段剩余期按高档补齐）。2026-08-25 前的遗留排队单仍由 PlanActivationTask 到期激活；迁移脚本 `scripts/activate-pending-renewals.ts` 可全部立即激活（幂等，先 --dry-run）。到期未续费自动降无等级：每日任务置空 tier + level 回写 NONE，钱包 level/身份读时按有效期推导
- **在线订单**（billing）：订单状态机 PENDING → PAID/EXPIRED/ABANDONED；Stripe webhook 为入账唯一事实源（结算前三道核对：PI 与订单原绑定一致 → 币种=USD → 实收金额=快照；绑定不符只告警不动单，币种/金额不符置 ABANDONED 转人工，均走 BILLING_ALERT_EMAIL）；**互斥单双保险**：个人套餐单（PLAN_NEW/RENEW/UPGRADE）与建队单（TEAM_PLAN/PERSONAL_TO_TEAM）互斥——下单/试算时存在对方未终态单 400，结算前复核身份/个人套餐快照（已入企业或快照失真 → ABANDONED 转人工，绝不按旧快照入账；占用中企业成员不可创建个人套餐单，DISABLED 成员除外）；**个人充值单（PACK/CUSTOM）占用中企业成员一律不可充（2026-09-01 产品收口，废 2026-08-29「成员允许个人充值」定稿）**：下单/试算 400（`OrderPricingService.assertPersonalRechargeAllowed`，`findOccupiedTeamId` 占用口径）+ 发起支付同源拦截（不建 PaymentIntent 不收款，兜「个人下单→入企业→再付待付单」）+ 结算复核（已入企业 → ABANDONED 告警转人工，兜「PI 已建→入企业→旧页面完成支付」尾竞态）；收据 = HTML 模板 + 系统 Chromium 渲染 PDF，邮件附件下发
- **团队**：共享池挂在 Team（批次 `CreditLot.teamId`），成员消费经 `UsageService` 路由到团队扣费（配额/折扣约束）；生命周期 ACTIVE → GRACE（30 天冻结，套餐/赠送批次保留、续费恢复时顺延完整恢复；**宽限期池余额展示含冻结批次（2026-08-29 起）**：poolBuckets/wallet 池汇总不按到期日过滤，冻结余额可见不显示 0，消费扣减路径不受影响）→ ARCHIVED（清套餐池、充值包退管理员、释放成员），GRACE 期内管理员可 `POST /team/:id/archive` 手动提前归档（与自动归档同一 `archiveOneTeam` 路径，幂等，审计 actorId=操作人）；平台定制单走 admin/teams 手工开通（不产生订单/收据），定制企业**不开放自助续费/席位升级**（2026-08-28 起 TEAM_RENEW 对 source=CUSTOM 直接 400，续费/席位调整走客户成功经理；TEAM_SEAT_UPGRADE 本就限自助团队），共享池充值（TEAM_PACK/TEAM_CUSTOM）仍可自助。个人转企业（PERSONAL_TO_TEAM）：折抵 = floor（月费 × min（剩余天数/30, 剩余 PACKAGE 套餐本体÷月发放 packageCredits）)（**2026-09-02 bug20 起只算 PACKAGE 本体**，注册/套餐/充值赠送、客服补偿等 GIFT 不再抬折抵；积分比例不封顶）；抵扣 > 企业价 → 实付 0（0 元单 `settleZeroAmountOrder` 免支付入账）+ 超出 ×10 返积分（去向随 packChoice：inject 入池 / keep 留个人）；订单 `creditsTotal` = 池积分+返还合计（2026-08-28 起，收据合计/支付记录/拒付反记账同口径），0 元单收据支付方式记「——」（存量冻结快照/旧单用 `scripts/fix-p2t-receipt-snapshots.ts` 修齐，幂等）；加入企业即注销个人订阅身份（tier/level/有效期全清，不恢复原档）。**TEAM_PLAN 建队单同口径支持 packChoice=inject（2026-08-29 起）**：支付后把购买人个人 RECHARGE 存量注入共享池（`transferRechargeLotsToTeam` 并入结算事务），缺省 keep 留个人；存量漏转数据用 `scripts/fix-teamplan-inject.ts --user X --team Y --order Z` 按单补转（幂等）；**成员规则（2026-08-27）**：席位占用 = ACTIVE+DISABLED 都占座（停用只限权限不释放席位，仅移出/归档释放；身份条/总览/满员拦截/平台列表/编辑下限同口径）；拉人（控制台/平台侧 `joinExistingUser`）拦截个人 PACKAGE+GIFT>0 的用户（400 引导走个人转企业折抵）与平台已停用账号（`isActive=false`，400「该账号已停用，不可加入企业团队」）；**归档身份（2026-08-28）**：归档后数据保留期（`dataKeepUntil`）内钱包身份仍识别 `TEAM_ARCHIVED_*`（入口保留 + TEAM_RENEW 续费恢复对归档管理员可用），控制台 GET 接口对归档管理员只读放行（`requireTeamAdminRead`，写操作仍 `requireTeamAdmin` 拦截），保留期过后身份回落个人；钱包 team 块归档摘要字段（2026-08-29）：`archivedAt`/`archivedMemberCount`（保留名单数）/`archiveReturned`（退回管理员个人户积分，仅管理员下发）/`myPoolUsedTotal`（本人企业段累计消耗），仅 ARCHIVED 有值；停用（DISABLED）成员线上购买个人套餐（PLAN_NEW/RENEW 结算）→ 自动移出企业（释放席位，审计 actorId=0，仅 DISABLED）；**记录隔离**：`/membership/transactions` 成员仅见本人流水，企业管理员=本人行 ∪ 本企业池行（teamId），成员个人侧流水不对管理员暴露，「使用用户」筛选 consumers 对管理员下发本企业成员；**扣费来源 consumeSource 8 值全覆盖（2026-08-29）**：个人 3（OWN_*）+ 邀请人 2（INVITER_*）+ 企业 3（TEAM_*；池消费 TEAM_CONSUME 按桶归类，平台池调整扣减归 TEAM_RECHARGE），行级 `classifyConsumeSource` 与筛选 `consumeSourceWhere` 同枚举同口径（选项经 transaction-options 一致下发，DTO 校验同源）；**调用方式 invokeType（2026-09-11）**：CreditTransaction 新增枚举列（PLATFORM 平台使用=默认 / API=开放平台扣费），API 由两个开放扣费入口（`/api/open/credit/deduct`、KeyB deduct）经 chargeModel→consumeRouted 显式透传打标（不从 meta 派生，平台侧 meta 调用方可控不可信）；`/membership/transactions` 返回 invokeType/invokeTypeLabel 并支持 invokeType 筛选（选项经 transaction-options.invokeTypes 下发、DTO 同源校验），邀请人下级流水委托同函数自动继承；存量回填 `scripts/backfill-transaction-invoke-type.ts`（meta.appId 判据，幂等）；钱包 team 块另有 `poolGrantedTotal`（池累计发放）/`poolManualDeducted`（平台手动扣减合计，2026-08-29）；**企业名显式命名标记 nameFilled（2026-08-29）**：建队未填名落默认名「{管理员用户名}的团队」时=false，建队填名/控制台/平台编辑显式改名=true（清空=false），前端「未命名/去补填」提示以此为准不再比对默认名字符串（照抄默认名的误判由此消除）；wallet/身份条/设置/平台列表均下发，存量回填 `scripts/backfill-team-name-filled.ts`（幂等，false→true 单向）；总览 overview 归档口径：席位/成员按归档保留名单统计（与成员列表同集合），提醒类（达限/临限/poolLow）归档恒不下发；**归档席位/成员统计全路径同口径（2026-08-29 补齐）**：身份条 identity、平台列表 listTeams seatsUsed、钱包 team 块 memberCount 对归档企业一律按 ARCHIVED 保留名单计数（不再显示 0）；配额页 listQuota 同口径返回归档保留名单（历史限额/已用原样保留），overview/listMembers/listQuota 三处读路径的跨月懒重置对归档团队跳过（updateMany where 带 team.status≠ARCHIVED，历史用量不清零）
- **返利**：多级计酬沿 `invitedById` 上溯（RebateRule.maxLayers，默认 2；**2026-09-01 起 maxLayers=null=不限层级**，沿链上溯到底，第 2 层起各层均用其 level2RebateRate），每层比例 = 邀请人 rebateRate / level2RebateRate；`rebateEnabled=false` 跳过该层链不断；每层金额**保留最多 4 位小数、不抹零**（2026-08-31 起，`quantize4`；此前取整口径已作废——不足 1 积分也照返，1×30%=0.3）；封顶 perInviterCap（**北京自然月**，`beijingMonthStart`，链上邀请人行 FOR UPDATE 串行化）/ perConsumeCapPct（单笔超限**等比缩放** 4dp，入账前再校验合计不超 `base×pct`）；**企业池段沿「企业邀请链」结算（2026-08-31）**：`Team.invitedById` = 建队时管理员 invitedById 快照（自助/定制两条建队路径固化；存量团队无快照结算回落当前管理员邀请关系），成员个人段仍沿个人链（`settleRebatesInTx` 的 `chainRootInviterId` 传链起点）；**企业段逐人开关（2026-08-31，原型「下级进企业后仍计返利」）**：`User.corpPassUp`（三元态，null=跟随全局 `corpCounts`，**逐人设定优先于全局**）+ 「被邀请人仍是该企业管理员」（当前管理员 invitedById ≠ 快照 → 该企业池段不返）；企业池段关 → 全员不返（含管理员本人池消耗），个人段不受影响；写入口 invite-config `corpPassUpToggles`（直接下级+占用中企业管理员校验），读入口 `admin/dist/users/:id/invite-rebate-detail`（rebate 汇总/network 人数/corpKids/upstreamRebateRate）；**计酬闸门（2026-08-31）**：逐层校验 rebateEnabled + isActive + canInvite（落库值）——关闭分销代理/停用账号立即停酬、跳层链不断，历史已入账不回溯；**邀请权落库制（2026-09-01 起，废 8-30 读时派生 `deriveCanInvite`）**：邀请权=本人 `canInvite` 落库值；上级（根分销，自身非被邀请人）打开 `subInviteAllowed` 时**批量打开**一级下级（写 canInvite=true + 发 7 天邀请码，人工单独关过的 `canInviteManualOff=true` 跳过、保持关闭），关闭时（含关闭本人邀请连带）**批量收回**（清码+连带 rebateEnabled=false+等级按订阅重算，不打人工标记——上级重开即恢复）；开关开着时 approve 通过的新下级落库即带邀请权+邀请码；被邀请用户不可开 `subInviteAllowed`（网络两级封顶）；**invite-config 后台直开拦截（2026-09-23 恢复 §4.1，废 9-01 放开）**：一级分销代理只开给平台直签账号（invitedById 为空）——`canInvite=true` 且目标 invitedById≠null 时，仅当「关→开」且其邀请人 canInvite+subInviteAllowed 双开关都在才放行（属二级范围内单独恢复，清 `canInviteManualOff`），否则 400 引导先开上级开关；单人关不拦（打 `canInviteManualOff`）；已开着的存量行重复提交 true 幂等不拦（否则无法保存其它配置）；存量派生数据用 `scripts/backfill-sub-invite.ts` 落库（幂等，先 --dry-run）；关闭本人邀请连带收回其 `subInviteAllowed` 并**连带写 `rebateEnabled=false`**（2026-08-31；**重开邀请（含上级重开开关批量恢复）同步写回 `rebateEnabled=true`**，2026-09-03 bug31 起，废「弹窗手动重开」口径）。**返利成本试算对账（2026-09-03 bug30）**：`previewRebateRules` 的 byInviter 明细量化到最多 2 位小数，顶部 rebateTotal = 量化后明细之和（rebatePct/highRisk 同源），接口返回值保证总额≡明细合计。**2026-08-31 收紧**：停用账号（isActive=false）邀请码即时失效（公开校验/注册 400「无效链接」）；名额用尽时 verify/register 入口即 400「该邀请链接名额已用完」（不再产生批不掉的死单）；返利提现（`POST /membership/rebate/withdraw` + 超管代发）**不再卡邀请权限**——关闭只停新增计佣，历史 REBATE 保留可提（提现金额放开整数限制，支持小数余额）；审批 approve/reject 条件更新原子认领（并发唯一终态，建号 P2002 → 409），运营侧代审队列 `admin/dist/applications`（同口径，代驳回不卡权限）；邮箱验证码重发作废旧码（仅最新可用，5 次连续错误作废当前码）；**register 校验顺序（2026-08-31 bug12）**：邀请码→手机号/待审占用/重复申请等可恢复校验全过后才核销邮箱验证码（校验失败不烧码，可原码重试），核销与建库相邻保持并发占位口径；**refreshCode 并发安全（2026-08-31 bug11）**：条件更新以旧码占位（`updateMany where id+inviteCode=旧值`），被抢先则重读返回最终有效码——所有成功响应的码必然有效；**invitees 列表注册时间筛选（2026-08-31 bug10）**：`startDate`/`endDate` 按 createdAt 过滤，边界用 `beijingDayStart/beijingDayEnd`（北京自然日整天，起>止 400）。「本月」口径全链路按 **Asia/Shanghai 自然月**（`common/utils/datetime.ts` `beijingMonthStart/beijingMonthKey`：返利月封顶/钱包本月已用/分销树本月/团队本月已消耗与配额懒重置 quotaMonthOf/用量分析本月上月筛选/客户工作台）
- **后台**：分销规则/关系树/试算/审批队列 `admin/dist/*`（tree 根节点带 `monthConsumed`/`monthRebateEarned`、二级节点带 `monthRebateContributed`；tree 支持 `scope=all/inviter/team/personal` 成员范围筛选，不匹配的一级成员含匹配二级时保留作上下文；**tree 一/二级节点均带按钮数据五件套 `canInvite`（本人独立开关原始值）/`discount`/`rebateRate`/`rebate`（可提现余额=REBATE 桶剩余）/`rebateEarned`（累计返利入账）**，前端据此放开节点按钮：邀请配置 depth≤1、返利提现 canInvite||rebate>0；**节点徽章数据（2026-08-31 第六批，根/一级/二级同口径）**：`effectiveCanInvite`（= 本人 canInvite 落库值，2026-09-01 起落库制无派生）/`isActive`/`team`（占用中企业 {id,name,role}，个人 null）/`monthTeamConsumed`（企业池段消耗，消耗聚合按 用户×类型 分组）/`rebateAttribution`（本月返利归属 [{userId,username,amount}]，收款人×消费者成对聚合实付口径，一级→根、二级→上级+根，>0 才有行；**2026-09-01 起企业管理员节点卷起本企业池段**：池段返利行落 `teamId`（consumeTeamInTx 透传 settleRebatesInTx），attribution/monthRebateContributed=个人段+池段合计，monthTeamConsumed=全队池消耗含本人；存量池返利行用 `scripts/backfill-rebate-team-id.ts` 回填 teamId）；**累计统计字段（2026-09-01 bug14/15）**：树节点 month* 之外并存 total*（节点消耗列（month/totalConsumed）对企业管理员=本人个人+本企业全队池、monthTeamConsumed/totalTeamConsumed 是其池子集做标注；`totalConsumed`/`totalTeamConsumed`/`totalRebateContributed`/根 `totalRebateEarned`/顶层 `networkTotalConsumed`，attribution 每项带 `totalAmount`）——全历史实付流水汇总，不按自然月过滤、不按现行规则追溯重算；**C 端 `listInvitees` 同口径卷起（2026-09-01 bug9 复修）**：占用中企业管理员下级的 `consumed` 计本企业全队池消耗、`rebateContributed` 含池段（普通下级只计本人行），与「使用记录」管理员视角（本人行∪本企业池行）对齐，根另带 `level1Total`，顶层 `networkCount`/`networkMonthConsumed`（不含根，按筛选后口径；**网络合计池去重（2026-09-07 bug30 复修，月/累计同口径）**：企业管理员节点已卷起全队池时，同企业成员节点的本人池行不再重复计入 networkMonth/networkTotalConsumed——节点自身展示口径不变，管理员不在树内时按成员本人池行计）；`POST rebate-rules/preview` 返利成本试算不落库、近 30 天消耗回放、返利/消耗>50% 出 highRisk、**`byInviter[]` 按团队长拆明细（预计返利合计+参与计酬消耗者去重人数，降序；maxLayers 传 null 不限层级，2026-09-01 bug15）**；**全局导出 `GET admin/dist/export`（2026-09-02 bug29）：全部网络一次导出，字段按原型（姓名/手机号/邀请人/身份/直接下线/消耗/返利归属/企业归属），消耗与返利归属全历史累计（复用 loadTree 聚合，手机号脱敏）**；**C 端邀请概览对被邀请人裁剪 `networkStats.level2RebateRate`（2026-09-02 bug23，返回 null 不下发上游比例）**；**企业详情成员行带 `inviter`/`rebateAttribution`（2026-09-02 bug26 分销下钻弹窗，池段返利卷起到管理员行、与关系树同口径）；顶层补 `inviter`（=Team.invitedById 快照对应用户）/`corpRebate {enabled,overridden}`（池段计返利状态，与 §5.6 corpKids 同语义）/`corpRebateTotal`/`members[].roles`（2026-09-03）；**corpRebateTotal=成员返利归属全量汇总**（个人段+池段、全历史实付，面板与成员明细逐项加总一致——2026-09-07 bug33 废纯池段口径）**；invite-config 名额边界（2026-09-02）：上限<已批才 400、上限=已用可保存（新增由 verify/register 入口拦截）**；`applications` 运营代审队列与邀请人自审同口径原子认领/名额/邀请人有效权闸门，代驳回不卡权限——均 2026-08-31 补）、个人订阅列表/客服补偿 `admin/subscriptions/*`（**延长有效期同步顺延仍有效的 RECHARGE_PLAN 来源 PACKAGE/GIFT 批次**——2026-09-02 bug22，与续费存量顺延同入口 `CreditService.extendPlanLotExpiryInTx`，只延不缩）、邀请配置 `PATCH admin/users/:id/invite-config`（列表/调整/邀请配置均走 `management.users` 权限点，不走充值白名单——订阅侧 2026-08-28 起、invite-config 自 2026-08-30 改；`GET admin/recharge/transactions` 与 **`GET admin/recharge/users`（2026-08-31 起）**、**`GET admin/recharge/users/:id/withdrawals`（2026-09-02 bug24）** 只读同样放行权限点——`@RechargeRead()` 放行口，充值写接口仍走 RechargeAccountGuard 白名单；**`admin/recharge/users` 的 `inviteStatus=inviter` 口径（2026-08-31 起）= canInvite=true 或返利余额>0（REBATE 桶 ACTIVE 剩余）**——已关邀请但未提完返利的用户仍留列表，后台返利提现入口不随邀请开关消失；`admin/recharge/users` 与 `admin/dist/tree` 的手机号默认脱敏，全号走 `/users/:id/phone` 审计接口）、用户列表扩展筛选（level/invited/teamId/hasTeam/canInvite）与手机号脱敏（全号 `GET /users/:id/phone` 写 History 审计）；用户列表行补 `rebateRate`/`invitedCount`（2026-08-31）、team 块带 `role`/`memberStatus`（停用成员保留企业归属；存量成员残留个人订阅字段用 `scripts/backfill-team-member-subscription.ts` 清零）

### 客户模块路由设计（`/api/customer`）

路由原则：创建/列表需要父级 ID，操作具体资源直接用自身 ID：

```
# 客户 CRUD
POST/GET /                         # 创建/列表
GET/PATCH /:id                     # 详情/修改
POST /:id/regenerate-strategy      # 重新生成运营方案（同步等待 Gemini）

# 账号（创建/列表挂在客户下，其余用自身 ID）
POST/GET /:customerId/account      # 创建/列表
GET/PATCH/DELETE /account/:id      # 详情/修改/删除
POST /account/:id/regenerate-strategy  # 重新生成账号方案

# 形象 & 音色（列表读时会对 GENERATING 行做 Xiling 对账）
POST/GET /:customerId/avatar       # 创建 / 列表
POST/GET /:customerId/voice        # 创建 / 列表
POST /webhook/avatar               # 曦灵训练完成回调
POST /webhook/voice                # 曦灵克隆完成回调

# 项目（创建/列表挂在客户下，其余用自身 ID）
POST/GET /:customerId/project      # 创建/列表
GET/PATCH/DELETE /project/:id      # 详情/修改/删除
PATCH /project/:id/topic           # 单独修改项目主题（同步 project.name + production.topic）
POST /project/:id/publish          # 发布 / 重新发布（COMPLETED/PUBLISHED 均可，publishedAt/publishUrl 可选，只覆盖传入值）

# 来源
POST/GET /project/:projectId/source         # 保存来源 / 读取
POST/GET /project/:projectId/deep-search    # 启动异步深度调研 / 轮询状态

# 方案
POST/PATCH /project/:projectId/strategy

# 生产层（content = 口播稿 + 发布文案 + 素材图片 + 分镜头）
POST /project/:projectId/script             # AI 生成口播稿（isAuto 标记）
POST /project/:projectId/copywriting        # AI 生成发布文案（isAuto 标记）
POST /project/:projectId/materials/generate # 批量生成素材图片（幂等，已有就返回）
POST /project/:projectId/storyboards/generate  # 批量生成分镜头提示词
POST /script/:id/synthesize-video           # 提交曦灵数字人视频合成
POST /webhook/video                         # 曦灵视频合成完成回调

# 分镜头席位视频（Veo 异步）
POST /storyboards/generate                  # 批量触发（按 id + 表单入参）
GET  /storyboards?ids=1,2,3                 # 批量按 id 轮询状态

# 素材图片变体（Nano Banana 异步）
POST /materials/generate                    # 批量触发
GET  /materials?ids=1,2,3                   # 批量按 id 轮询状态

# 其他
GET /tags                          # 标签列表
GET /stats                         # 基础实体计数（customers/accounts/avatars/projects）
GET /dashboard/stats               # 社媒运营员工作台卡片
GET /projects                      # 全局项目列表（仅 status 筛选，分页）
```

### AI 策略生成（`src/customer/customer.prompts.ts`）

Prompt 模板抽离在 `customer.prompts.ts` 中，Service 调用 `GoogleProvider.generateText()` 生成：

- **客户运营方案**：创建客户时异步生成，`POST /:id/regenerate-strategy` 同步重新生成
- **账号规划方案**：创建账号时异步生成，`POST /account/:id/regenerate-strategy` 同步重新生成
- 生成结果存储在对应模型的 `strategy` 字段（`Text`）

### 项目工作流（三层结构）

项目内容生产分三层：

- **来源层**（Source）：一对一挂在 Project；`SourceType`（HOT_TOPIC / CLIENT_BRIEF / DEEP_RESEARCH）。DEEP_RESEARCH 复用 Source 行做异步状态（`status` / `query` / `errorMessage`），手动保存 source 时会重置这些异步字段
- **方案层**（Strategy）：业务结合方式 + 目标时长 + 方案内容
- **生产层**（Production）：口播稿 Script、发布文案 CopyWriting、素材图片 MaterialImage(+Variant)、分镜头 Storyboard(+Video)。一个项目的 production 自动在首次生成内容时创建

### 项目状态机

`ProjectStatus`：**DRAFT → PRODUCING → COMPLETED → PUBLISHED**

- DRAFT → PRODUCING：**仅** 在第一次写 source / 启动深度调研时自动推进（`saveSource` / `startDeepResearch`）。COMPLETED / PUBLISHED 再调这些接口**不会退档**
- PRODUCING → COMPLETED：`maybeCompleteProject` 在任一内容生成接口末尾触发；仅当 Script + CopyWriting + MaterialImage + Storyboard 四件套都有行 **且** 当前仍是 PRODUCING 时才推进
- COMPLETED → PUBLISHED：`POST /project/:id/publish` 手动触发。已 PUBLISHED 可再次调用覆盖 `publishedAt` / `publishUrl`（未传的字段保留原值）

### 异步任务架构

两类异步任务，分别处理策略不同：

**本地驱动**（Veo / Nano Banana / Gemini Deep Research）：
- fire-and-forget + DB 状态机（`status`：GENERATING / SUCCESS / FAILED）
- 每条任务带 10 分钟墙钟超时（`ASYNC_TASK_TIMEOUT_MS`，见 `withTimeout`）
- 进程重启会丢失 Promise → `onModuleInit` 扫描 `updatedAt` 早于 15 分钟的 GENERATING 行直接标 FAILED

**曦灵驱动**（形象 / 音色 / 数字人视频合成）：
- 状态同样归一为 GENERATING / SUCCESS / FAILED；webhook 的 `WAIT` / `FAIL` 在 `applyAvatarStatus` / `applyVoiceStatus` / `applyVideoStatus` 里转译
- Baidu 在跑，进程重启不会丢任务，但 webhook 可能丢失 → 提供**读时对账** + **启动对账**兜底：
  - `findAllAvatars` / `findAllVoices` 返回前对 GENERATING 行调 query 接口（2 分钟节流）
  - `onModuleInit` 强制对账所有 GENERATING 的形象/音色/Script.videoStatus（不节流）
- Webhook handler 和对账函数走同一条 `applyXxxStatus` 落库路径，不重复实现归一化逻辑

**定时任务**（`@Cron`，均带启动时补偿执行；日级墙钟任务一律 `timeZone: "Asia/Shanghai"`——容器为 UTC，不钉会偏移 8 小时；间隔类任务无需时区）：

- `CreditExpiryTask`（membership）：每日 0 点（Asia/Shanghai），过期**个人**批次清零（PACKAGE/GIFT）；**团队批次不清**（2026-08-29 起）——团队批次随团队同日到期，GRACE 宽限期保留（续费恢复时 `restoreTeam` 顺延至新有效期、完整恢复），归档时统一清零留痕；存量误回收用 `scripts/restore-grace-team-lots.ts` 修复（幂等）
- `PlanActivationTask`（membership）：每日 0 点（Asia/Shanghai），到期的 ScheduledPlan 排队套餐激活（**仅服务 2026-08-25 前的遗留排队单**；新续费立即生效不再排队）
- `OrderExpiryTask`（billing）：每 5 分钟，订单超时收口（全渠道统一 15 分钟未支付 → EXPIRED，含从未发起支付的 CREATED）
- `TeamLifecycleTask`（team）：每日 0 点（Asia/Shanghai），企业到期 → GRACE 冻结；GRACE 满 → ARCHIVED（清套餐池、充值包退管理员个人户、释放成员归属）
- `ExpiryReminderTask`（billing）：每日 01:30（Asia/Shanghai），到期提醒邮件（个人/团队统一 **到期前 T-7/3/1 各一封**续费提醒，到期当天/过期后不发；旧版延迟一天的过期次日/GRACE 首日两封已取消），窗口按**北京自然日**整天切自然去重（取日与邮件日期展示均钉北京时区，与容器时区无关），email 为空跳过

### 数据库

Prisma + MySQL。

**基础模型**：User、SmsCode、History、ProductReport、SelectedProduct、RoleModel、Permission、RolePermission、PricingConfig、UsageLog

**计费模型**：MembershipPlan、RechargePack、CustomLadderTier、CreditLot、CreditTransaction、ScheduledPlan、RebateRule、InviteApplication、BillingOrder、Team、TeamMember、TeamModelConfig、TeamAuditLog、FeatureModule（功能模块注册表，扣费 source 校验/标签单一事实来源，seed `features` 维护）、OpenApiApp（对外开放接口接入方）

**客户模型**：Customer、Account、Avatar、Voice、Project、Source、Strategy、Production、Tag、Script、CopyWriting、Storyboard、StoryboardVideo、MaterialImage、MaterialImageVariant

**枚举**：Role、HistoryType、TagCategory、ProjectStatus、SourceType

**软删除**：通过 `PrismaService.$extends` 对 `SOFT_DELETE_MODELS` 列出的模型自动注入 `deletedAt: null` 过滤，覆盖 findMany/findFirst/findUnique/count/aggregate 等所有读操作。新增带 `deletedAt` 的模型时记得往 `SOFT_DELETE_MODELS` 加一条

### 测试规范

Jest + Mock `PrismaService`。通过 `Test.createTestingModule` 配置 `{ provide: PrismaService, useValue: mockPrisma }`，对 Prisma 模型方法使用 `jest.fn()` 进行模拟。

## 关键配置

- **TypeScript**：目标 ES2023，nodenext 模块，严格模式，启用装饰器
- **ESLint**：扁平化配置（`eslint.config.mjs`），`@typescript-eslint/no-explicit-any` 已关闭。**`npm run lint` 带 `--fix`、`npm run format` 带 `--write`，会重写全仓库格式——只允许对本次改动的文件做只读检查（`npx eslint <改动的文件>`），严禁全仓 lint/format**
- **Docker**：多阶段构建，node:22-alpine，以非 root 用户 `appuser` 运行，入口先执行 `prisma db push --accept-data-loss --skip-generate` 再启动应用；runner 阶段装了系统 Chromium（收据 PDF 渲染用，`PUPPETEER_EXECUTABLE_PATH` 指向它）
- **环境变量**：
  - `DEFAULT_MEMBER_ROLE_ID`：邀请审批（含运营代审）/企业添加成员时新建账号绑定的默认平台角色 ID；不继承邀请人角色。企业拉入已有账号保留原平台角色（含无角色），不追加默认角色、不依赖此配置；邀请审批沿用原绑定规则。需要绑定时配置缺失/非法/角色不存在则操作失败并回滚，修改后重启生效
  - `DATABASE_URL`、`JWT_SECRET`
  - `GEMINI_API_KEY`（Google 全系 AI）
  - `ACCESS_KEY_ID` / `ACCESS_KEY_SECRET`（阿里云短信；若启用 OSS 同样复用）
  - `XILING_APP_ID` / `XILING_SECRET_KEY`（百度曦灵）
  - `APIFY_API_TOKEN`（Apify 平台 API Token，灵感雷达模块抓取 Pinterest/Instagram/TikTok 内容；未配置时抓取接口返回空结果）
  - `API_BASE_URL`：公网可达的服务域名，用于拼曦灵 webhook 回调 URL；本地开发需通过 ngrok / cpolar 类工具转发

  - `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET`（在线支付三渠道；未配置则在线支付不可用，不影响其它功能启动）
  - `BILLING_ALERT_EMAIL`：计费告警收件人（金额不符/拒付/入账失败），多个逗号分隔
  - `PUPPETEER_EXECUTABLE_PATH`：收据 PDF 用系统 Chromium 路径（如 `/usr/bin/chromium-browser`）；未配置则收据邮件无 PDF 附件
  - `MAIL_FROM` / `MAIL_FROM_ALIAS` / `MAIL_DM_ENDPOINT`：阿里云 DirectMail 普通 HTML 邮件通道（到期提醒等）
  - `AI_GATEWAY_API_KEY` / `AI_GATEWAY_BASE_URL`（智擎 AI 中转站；启用竞品分析还须 `SIF_API_KEY`，数据源密钥 `KEEPA_API_KEY`/`SELLERSPRITE_SECRET_KEY` 仅后端持有）

## 进行中：通用生图管线迁移（跨仓库，2026-08 启动）

**分支固定约定**：本任务的全部工作固定在本仓库的 `refactor/image-module` 分支进行（前端仓库 amazon-agent 同名分支）。任何会话在本仓库开始工作前先 `git branch --show-current` 确认；若发现当前不在该分支且存在未提交的 `src/image-generation/` 相关改动，必须先切回该分支并确认改动完好，再继续其他操作。其他任务请使用其他分支或独立 worktree，禁止在迁移工作未提交时切走分支。

将前端仓库（同级目录 `../amazon-agent`，Next.js BFF）三条通用生图链路（generate / text-to-image / image-to-image）的执行、状态与取消迁入本仓库。

- 方案同步副本：`docs/designs/2026-08-28-image-generation-pipeline-backend-migration.md`。事实源头在前端仓库 `../amazon-agent/docs/superpowers/specs/` 同名文件——修改只改源头再同步到副本。注意：本仓库 `.gitignore` 忽略 `docs/**`，该副本仅存在于本地，不随 git 分发；拉取本仓库后如缺此文件，以前端仓库源头为准
- 落点：新模块 `src/image-generation/`（controller + executor + `core/` 移植层），不改 `image-project` 既有接口语义
- 执行模式：照搬 `video-project` 的"DB 状态 + `updateMany where status='GENERATING'` CAS 推进 + `onModuleInit` 启动对账"，外加租约列；不引入队列中间件
- Prisma 变更只增不改：generate 复用 `GenerationTask/GeneratedImage` 加列（executionSpec/租约/attempt/gatewayTaskIds/gatewayEventId），t2i/i2i 新增 `ImageGenJob/ImageGenItem`（快照轮询 30 分钟 404 契约由 GET 读路径判定；终态行自 2026-09-11 起默认永久保留作生成记录数据源，`IMAGE_GEN_JOB_RECORD_RETENTION_DAYS` 可收紧）
- 新端点仅由 Next 服务端转发用户 Bearer 调用（`JwtAuthGuard` + 归属校验）；浏览器侧轮询路径不变
- 硬门禁：与前端仓库现状实现行为等价——prompt 编译 hash、五个端点响应快照、错误文案逐条一致（方案 §8），不达标不切流
- **模型目录/计费倍率统一（2026-09-07，脱离前端等价口径的产品决议）**：①模型下拉 `GET /api/image-generation/models` 不再直连网关 `listImageModels`，与其他模块同口径读 `AiGatewayModel` 本地目录（`modality=IMAGE` + `category=IMAGE_GENERATION` + `enabled` + `gatewayActive`，读时经 `AiGatewayModelService.maybeRefreshModels` 后台刷新；`AiGatewayModule` 已导出 `AiGatewayModelService`）；上架用 `scripts/onboard-ai-gateway-image-model.ts`（缺省 category=IMAGE_GENERATION，参照 video onboard），未建行不展示（前端回落静态清单）。②网关金额扣费倍率不再读 env `IMAGE_GATEWAY_CREDIT_MULTIPLIER`（已删除），与其他模块同口径取 `AiGatewayModel.priceMultiplier`（执行器 `loadPriceMultiplier`：逻辑 ID 先经 `resolveGatewayModel` 解析到网关 model 再查 `usage.gatewayPriceMultiplier`，direct 槽位/目录缺行按 1，查询失败按 1 续跑只记日志）；token 计费路径不乘倍率，与网关回调计费口径一致。同 PR 顺带删除 `gateway-mapping.ts` 中已无引用的 `DIRECT_MODEL_SLOTS`。**注意：该决议打破「与前端现状等价」硬门禁中计费倍率一项（前端 BFF env 倍率默认 1，后端 DB 倍率图片 3），切流/对账时以 DB 倍率为准**
- **B4 direct 通道退役（2026-09-10 落地）**：`IMAGE_PIPELINE_GATEWAY_TARGET` 开关与 `gatewayTargetEnabled` 已删除，本模块 provider 工厂**只产网关适配器**（`core/` 的 8 个直连 provider + `model-factory.ts` + `providers.ts` 共 12 个文件已删，含各自 spec；共享层 size-adapters/prompt-builder/retry-utils/storage/Finalizer 等保留，P0 等价性套件不受影响）。provider 解析口径（`gateway-mapping.ts`）：6 个逻辑 ID 按映射表到网关 model（atlas-gpt→ZQ-Image-2-Backup 等）、**退役槽位 atlas-wan/tokenlab-gpt-image/chadgpt-ru 在三条端点入口 400「Unsupported provider: xxx」（网关无对应模型；不透传是因 no-route 会被误译成尺寸能力错误）**、其余任意字符串视为目录直传的网关 model id 原样透传（网关侧校验）。附带修复：i2i `clampI2ICountForProvider` 对动态 id 的 map 取值 undefined→NaN 隐患（兜底 4）；`buildWanEditPrompt` 分支从执行链移除（函数本体保留在 prompt-builder 供等价性矩阵重放）。前端 BFF 自身的 direct 双模式是前端仓库能力，不受本改动影响；但 BFF 转发到本模块的请求一律网关通道
- **特殊比例尺寸处理收敛 gateway 单通道（2026-09-07 决议，2026-09-10 已实现）**：~~direct 槽位不再使用（后续随 B4 退役）~~（B4 已落地，见上条），**不迁移**前端的 `provider-size-policy` 能力表层与 per-provider 尺寸适配差异（`adaptAtlasGptImage2Size`、gemini 槽位 aspect_ratio 口径、三个 official 槽位均不补）。特殊比例的处理全部收敛在网关适配器一层：越界比例档（21:9/5:4/4:5）与自定义比例经 size 回退/intent sizing 后，任务成功时由 `providers/gateway-size-normalize.ts`（sharp）把产物裁回用户表单目标比例（cover + attention 焦点、lanczos3、放大补 sharpen；无 alpha 转 jpeg 94/4:4:4、带 alpha 保 png，输出 data URL 由执行器 hostImage 转存）；尺寸已一致免二次编码；pixels 模式与交付计划工作尺寸仍归 Delivery Planner；归一失败保原图只记日志（best-effort，已成功的图不能丢）。网关原生 7 档比例直传不触发归一（零开销）。**custom ratio 请求侧同改（2026-09-10）**：`aspectRatio=custom`（ratio 模式）不再发比例串（网关上游普遍吸附），改发按档位长边推导的精确 `size`（与 `resolution`/`aspect_ratio` 互斥，见 `gateway-image-sizing.ts` 冲突校验；推导结果超出网关 64~8192 边界回退 intent 发送）。配置：`IMAGE_GATEWAY_SIZE_NORMALIZE`（默认 on，off 一键回退现状）、`IMAGE_GATEWAY_SIZE_NORMALIZE_SKIP`（逗号分隔网关 model id 豁免，网关侧验收 G1~G3 也用它）、`IMAGE_GATEWAY_NORMALIZE_MAX_PIXELS`（默认 20_971_520=20MP，覆盖 Gemini 4K 宽幅实测 17.03MP 产物，超限保原图）；归一触发落 `gatewayImage.normalized`（from/to/ops）供观测对账
- **通用生图管线终态改走 callback（2026-09-10，由纯轮询改造）**：网关适配器提交 `callback:true`，终态以网关 `image.task` webhook 为主信号——新增 `ai-gateway/ai-gateway-image-callbacks.service.ts`（进程内 waiter hub + 60s 近期终态缓存兜「回调先于 waiter 注册」竞态 + **管线幂等键前缀常量** `IMAGE_PIPELINE_IDEMPOTENCY_PREFIX="imggen:"`），`ai-gateway-webhook.service` 的 image.task 分发**先问 hub**（命中即消费并 204）；**无 waiter 但 `request_id` 带 `imggen:` 前缀的管线任务安静吞掉**（waiter 已不在=进程重启/多副本回调落错副本/晚到回调，管线不走 GenerationTask 落库路径，查不到会 503 引发网关重试风暴——回调事件不回显 callback_data，识别只能靠 request_id 前缀，故前缀必须走单一来源常量）；其余继续走 image-project 人像/AI拆图的 applyImageTask 落库+扣费老路径，两线互不干扰。适配器内保留稀疏 backstop 轮询兜回调丢失/本地开发无公网回调（`IMAGE_GATEWAY_CALLBACK_BACKSTOP_MS` 默认 15s、下限 1s），deadline 语义照旧（`IMAGE_GATEWAY_POLL_TIMEOUT_MS` 默认 480s，到点先终检一次再判 transient_timeout）。执行器模型零改动（租约 CAS/归一化/T8 重试/计费原样在 provider 返回之后的路径）。**审计补齐（同日）**：generate 执行器 settle 时写图片行 `providerJobId`（网关任务 id，任务级 gatewayTaskId 因 1:N 不写）、t2i/i2i item 的 `gatewayImage` JSON 注入 `gatewayTaskId`（任务↔网关任务关联此前只活在计费 meta）；generate 幂等键前缀 `gen:` 统一为 `imggen:`。**单实例语义**：waiter 是进程内的，多副本部署时回调副本 ≠ 提交副本则退化为纯 backstop 轮询（行为正确只是慢），生产部署需注意；本地开发网关回调不可达，一直走 backstop，行为等价旧轮询
- **瞬态失败进程内重试（2026-09-10 T8）**：t2i/i2i 执行器 catch 分支——`RelayError` 且 `kind` 为 `transient_*` 且 attemptNo<3 时 CAS `RUNNING→QUEUED`（清租约）+ 退避档（2s/8s）后经 Dispatch 队列重投本进程，**重投带墙钟 deadline 守卫**（`executor/job-deadline.ts` 单一来源，t2i 10min/i2i 15min，过线不再重投交对账收敛——前端超时已先生效，晚成功不可见只多花额度）；`permanent_*`（参数/鉴权/额度/尺寸能力）与预算耗尽仍直接 FAILED（耗尽时 errorMessage 带「已自动重试 N 次」）。开关 `IMAGE_GEN_INPROCESS_RETRY`（默认 on；off=回退无重试现状——测无重试基线/排查时用）。**产物托管（hostImage）另有原位重试**（1s+3s 退避，只重传产物不重跑网关不双花额度——2026-09-10 实测 DO Spaces 瞬时 NoSuchBucket 抖动由它自愈）。幂等键含 attemptNo：新 attempt=新网关任务，「轮询超时」类瞬态重试存在双开任务（平台侧双花网关额度、用户侧单扣费不受影响），一期接受、二期按观测数据决策续捞；观测日志：失败/重投带 `{item,job,provider,attempt,kind,ms,backoffMs}`、成功>180s WARN slow generation
- **t2i/i2i 并入用户生成记录 + 基座对账锚点补齐（2026-09-11 落地，方案见本地 docs/designs/2026-09-11-imagegen-records-visibility-and-gateway-links.md）**：①`GET /api/usage/generation-records` 的 IMAGE 维度新增数据源 `ImageGenJob`（key 前缀 `IMAGEGEN:{jobId}`，status 映射 COMPLETED→SUCCESS，resultLabel「文生图/图生图 · 成功 x/N 张」），`ImageGenJob` 加 `model`/`prompt` 审计快照列（MySQL 下 Prisma 不支持 JSON path 过滤）+ user 关系；**积分反查键 `meta.jobId`（字符串，generate 是数字 `meta.taskId`、拆图是 `groupId`，键型天然不混淆）**，`imageGenCreditsByJob` 多流水聚合、`sumImageGenCredits` 并入 totalCredits、model-options 同步并入。②保留期解耦：reconciliation 清理改按 `IMAGE_GEN_JOB_RECORD_RETENTION_DAYS`（默认 0=永久），快照轮询 404 契约不变（读路径判 expiresAt）；存量行已被旧 Cron 硬删不可恢复。③对账快照：管线扣费 meta 统一补 `gatewayAmountCny`+`priceMultiplier`（与老 webhook 路径同口径）；item settle 补写 `providerJobId` 列（generate 图片行同款）。④任务级网关关联：`GenerationTask.gatewayTaskIds` Json 数组（1:N 完整表达，flush 聚合点读-合-写幂等，恰好 1 个时单值 `gatewayTaskId` 同步冗余）；webhook image.task 分发点对带 `imggen:` 前缀的终态事件按幂等键回解（`parseImagePipelineIdempotencyKey` 共享解析器：数字 owner=generate taskId、UUID owner=jobId）写 `GeneratedImage`/`ImageGenItem` 的 `gatewayEventId`（纯审计 best-effort，结算闸门仍是执行器 CAS；imggen: 回调在 applyImageTask 之前被吞，不误触老路径幂等）。⑤存量回填 `scripts/backfill-generation-gateway-links.ts`（幂等 + `--dry-run`，从 UsageLog requestId `charge:imggen:*` 反解；priceMultiplier 因折扣参与无法反推、gatewayEventId 无源，均明示不补）。⑥**批量改图入库行挂积分 + 去重（同日补丁）**：批量改图（选项目发起）完成后经 `POST /api/image-project/:id/task` 把成品归档为 STANDARD 任务行——`GenerationTask.sourceJobId`（新列）记源 ImageGenJob.id，createTask 同事务回写 `ImageGenJob.taskId`（该列本就是为 i2i↔项目任务关联设计的，迁移断链在此接回）；生成记录视图据此**入库行按 meta.jobId 挂积分（不再空积分）、已归档 job 的 IMAGEGEN 行隐藏（where `taskId:null`）**，`sumImageCredits` 同口径分流不双计；前端 `archiveGroupToProject` 传 sourceJobId（group 与 variant 两路）；存量链接用 `scripts/backfill-archived-task-links.ts`（URL 精确匹配 + 创建即终态特征，幂等 + `--dry-run`，已对 UAT 执行：5 条链接/160 条老 BFF 归档无从链接保守跳过）
- **网关图片准入边界适配 + 3K 档下线（2026-09-14，UAT 特殊比例批量失败排查落地；网关侧移交清单见本地 `docs/references/2026-09-14-imagegen-special-ratio-incidents.md`）**：①网关 size 准入实测为**每边 512~4096、总像素 ≤4096²、比例 1:16~16:1**（越界在准入层 400 `below the minimum edge 512px`，不进上游不落调用日志）——`gateway-image-sizing.ts` 新增 `clampToGatewayImageAdmission` 单一来源，网关适配器 pixels 字面量与 custom 比例推导 size 统一先收敛进边界（短边 <512 等比抬升保比例，10:3@1K→1708x512；长边 >4096 等比缩回），比例超 8:1（512×4096 为边界内可表达极限）回退 intent——**比例串须约分后 ≤2 位数/边**（网关 pattern `^\d{1,2}:\d{1,2}$`，3 位数如 463:45 只能发钳制 size 由归一化层裁回）；产物归一化目标不变（`gatewayNormalizeTargetSize` 仍按用户表单字面/档位意图）。②**3K 档已被网关全目录下线**（8 个图片模型 resolution 枚举一律 `1k/2k/4k`）：三链路入口统一降档 2K（`normalizeResolutionTier` 返回值映射 + t2i 显式降档；`ResolutionTier` 类型与 TIER_LONG_SIDE 保留 3K 服务存量快照重放，网关适配器 `gatewayResolutionValue` 兜底把历史 3K 映射 `2k`）；本地镜像 `gatewayImageSizingSchema` enum 同步收窄、`normalizeGatewayImageSizing` 对 3k 提前硬拒。③`isSizeRelatedError` 补 `minimum edge`/`maximum edge` 关键词（准入类 400 归「该模型不支持此比例/清晰度」而非「参数不合法」）。④P0 等价性矩阵对 3K→2K 的三例口径差以**已记录偏差登记表**显式豁免（`equivalence.spec.ts` 的 KNOWN_DEVIATIONS，录制件与 sha256 不动、登记有效性有断言守护）——与 2026-09-07 计费倍率决议同类的「打破前端等价硬门禁」项，切流对账以降档后口径为准。⑤遗留：人像/AI 拆图（image-project）若配了 3k 档 model_params 会被镜像层提前 400（与网关同口径，属正确拦截）；电商 2:3+ZQ-Image-1 超时=网关 G4 主通道挂起，未做自动切 Backup
- **尺寸×档位回归脚本（2026-09-09）**：`scripts/test-image-generation-sizing.ts`（`npm run image-generation:size-test`，也可 `npx tsx`）走本模块 HTTP API 对目录模型做「比例×档位 + PRD 特殊尺寸/自定义像素」矩阵生成测试：常规比例走 t2i intent、特殊尺寸走 i2i custom 像素（main 参考图缺省自造合成图），记录 jobId/终态快照/网关就近适配/下载实测尺寸/耗时/错误原文（含 sizeRelated 分类），判定口径沿用 PRD e2e，增量合并落 `docs/references/image-size-matrix-raw.json` + `-report.md`（本地，docs/** 不入库）。需 `TOKEN`（web 登录 JWT）+ `BASE`（默认 localhost:8000；`--bff`/`BFF=1` 改打 web 的 /api/ai-creative）；真实消耗积分，>3 用例需 `--yes`，先 `--dry-run`/`--filter` 缩范围。前端仓库配套文档《生图尺寸与分辨率后端测试指南》
- **站点→图上文字语言动态控制（2026-09-19）**：背景=用户选了站点（如 Amazon US/MX）但图上文案仍是中文——图片模型/网关没有站点/语言参数，语言只能靠 prompt 头尾硬性指令；此前通用生图链路根本不读 `market` 字段、AI 拆图只有一条给规划 LLM 的软规则。落定：①新共享模块 `src/common/utils/marketplace-language.ts`——`COUNTRY_LANGUAGES`（国家码→locale/语言名，覆盖全部亚马逊在营国家+主流跨境电商市场，UK/GB 别名）+ `resolveMarketplaceLanguage`（`平台_国家码` 大小写/分隔符归一，语言**只看国家码、平台无关**，新站点 temu_br/tiktok_mx 零改动自动生效）+ head/tail 硬指令文案与 `FALLBACK_MARKETPLACE_LANGUAGE`（解析不出兜底**英文**，产品口径）。②通用生图：`market` 进表单白名单，prompt 编译时站点语言指令替换"跟随提示词语言"基座并覆盖 zh 缺省（优先级：无文字＞站点＞targetLanguage）；**market 缺省输出与现状逐字节一致**，P0 等价性录制件/KNOWN_DEVIATIONS 不动。③AI 拆图：`AI_SPLIT_SITES` 枚举退役改格式校验 `^[A-Za-z0-9]+[-_][A-Za-z]{2}$`（非法 400「站点格式不合法」）；`SITE_LOCALES` 删除，locale/显式 language 标签走动态推导（国家查不到 locale 回落 en-US、资料再走 defaultLocale 既有回落）；规划提示词升 **v4**（【六】第 4 条改硬规则：全部图上文案用 generation_settings.language，资料为其他语言先翻译禁止照抄；generation_settings JSON 注入显式 `language` 字段）；`submitImageTask` 终稿头尾包语言指令兜底（textAmount=NONE 跳过）。前端两链路本就已在发 market/site，无需前端改动
- 进度：P0 等价性基线 + P1 本模块（13 套件 548 测试）+ P2 前端 BFF 双模式开关 + **P3 本地联调通过（2026-09-01，generate/t2i 已 E2E 验证；i2i 待补一次批量修图验证）**。曾并入 origin/uat（PR #106），2026-09-01 被 revert（2a82cf3）；本分支在 2026-09-02 反向同步 uat 后 revert 该 revert 恢复模块——下次再合入 uat 前先确认 revert 当初的原因已消除。dist 布局修复（1200208，`tsconfig.build.json` 排除 `prisma.config.ts`）随 uat 反向同步已带上。灰度上线按前端仓库方案 §12.2 手册执行。修改 `src/image-generation/` 行为时，对应的 `*.spec.ts` 与前端仓库 `pipeline-proxy.test.ts` / `route.test.ts` 契约必须同步更新。
