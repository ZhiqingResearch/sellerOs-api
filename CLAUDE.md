# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
npm run db:migrate         # prisma migrate dev（开发环境）
npm run db:deploy          # prisma migrate deploy（生产环境）
npx prisma generate        # Schema 变更后重新生成 Prisma Client
npx ts-node prisma/seed.ts # 初始化种子数据
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
| SmsModule | `src/sms` | 阿里云短信验证码 |
| HistoryModule | `src/history` | 操作历史记录 |
| ProductReportModule | `src/product-report` | 产品报告 |
| SelectedProductModule | `src/selected-product` | 选品管理 |
| CustomerModule | `src/customer` | 客户中心（客户、账号、项目、来源、方案、生产、形象、音色、标签、dashboard） |
| OssModule | `src/oss` | 阿里云 OSS 上传 |
| InspirationRadarModule | `src/inspiration-radar` | 灵感雷达（订阅管理、Apify 抓取、存素材池） |
| ProvidersModule | `src/common/providers` | 全局 AI Provider（`@Global()`） |

### 全局 Provider（`src/common/providers/`）

第三方服务统一封装为 Provider，通过 `ProvidersModule`（`@Global()`）注册，所有模块可直接注入：

- `GoogleProvider`：统一封装 Google 全系 AI 能力（`@google/genai`）。文本 Gemini 2.5 Flash（`generateText` / `deepSearch`），图片 Nano Banana 2（`generateImage`），视频 Veo 3.1 Lite（`startVideoGeneration` / `pollUntilDone` / `downloadVideo`，时长仅 4/6/8 秒）
- `BaiduXilingProvider`：百度曦灵数字人/音色克隆/视频合成（异步 webhook 回调；并提供 `queryAvatar` / `queryVoiceClone` / `queryVideoTask` 用于对账）
- `ApifyProvider`：Apify 平台集成（灵感雷达），封装 Pinterest / Instagram / TikTok 三平台关键词搜索，同步获取结果并归一化为统一 `ApifyMediaItem` 结构

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

### 数据库

Prisma + MySQL。

**基础模型**：User、SmsCode、History、ProductReport、SelectedProduct、RoleModel、Permission、RolePermission、PricingConfig、UsageLog

**客户模型**：Customer、Account、Avatar、Voice、Project、Source、Strategy、Production、Tag、Script、CopyWriting、Storyboard、StoryboardVideo、MaterialImage、MaterialImageVariant

**枚举**：Role、HistoryType、TagCategory、ProjectStatus、SourceType

**软删除**：通过 `PrismaService.$extends` 对 `SOFT_DELETE_MODELS` 列出的模型自动注入 `deletedAt: null` 过滤，覆盖 findMany/findFirst/findUnique/count/aggregate 等所有读操作。新增带 `deletedAt` 的模型时记得往 `SOFT_DELETE_MODELS` 加一条

### 测试规范

Jest + Mock `PrismaService`。通过 `Test.createTestingModule` 配置 `{ provide: PrismaService, useValue: mockPrisma }`，对 Prisma 模型方法使用 `jest.fn()` 进行模拟。

## 关键配置

- **TypeScript**：目标 ES2023，nodenext 模块，严格模式，启用装饰器
- **ESLint**：扁平化配置（`eslint.config.mjs`），`@typescript-eslint/no-explicit-any` 已关闭
- **Docker**：多阶段构建，node:22-alpine，以非 root 用户 `appuser` 运行，入口先执行 `prisma migrate deploy` 再启动应用
- **环境变量**：
  - `DATABASE_URL`、`JWT_SECRET`
  - `GEMINI_API_KEY`（Google 全系 AI）
  - `ACCESS_KEY_ID` / `ACCESS_KEY_SECRET`（阿里云短信；若启用 OSS 同样复用）
  - `XILING_APP_ID` / `XILING_SECRET_KEY`（百度曦灵）
  - `TOKENLAB_API_KEY`（TokenLab 中转，视频创作 Grok Imagine 档位；可选 `TOKENLAB_BASE_URL`）
  - `APIFY_API_TOKEN`（Apify 平台 API Token，灵感雷达模块抓取 Pinterest/Instagram/TikTok 内容；未配置时抓取接口返回空结果）
  - `API_BASE_URL`：公网可达的服务域名，用于拼曦灵 webhook 回调 URL；本地开发需通过 ngrok / cpolar 类工具转发
  - `INTERNAL_ACCOUNT_PHONE`：内部账号手机号白名单（多个逗号分隔），仅这些账号可访问菜单/路由配置接口（`/api/menus*`，连超管也挡，见 `InternalAccountGuard`）；留空回退默认 `18888888888`
  - `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM`（邀请注册的邮箱验证码发送，见 `MailProvider`）；未配置时邮件发送接口返回 503，不影响其它功能启动
