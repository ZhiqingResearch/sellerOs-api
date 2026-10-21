-- 车泰斗统一上线 SQL（2026-10-08）
-- 以当前 prisma/schema.prisma 为准；仅包含车泰斗 9 张表与复用生图表的扩展。
-- 新建业务表的159个字段及12个生图扩展/调整字段均附带中文COMMENT，执行后可在数据库字段详情查看。
-- 替代 prisma/chetaidou-2026-09-28.sql 和 2026-10-06 预览墙增量文件。
--
-- 适用：已经安装 SellerOS 基础表、首次上线车泰斗，或重复执行补齐本文件所列扩展。
-- 全新平台空库请先 npm run db:push 安装基础表；本文件不创建其他平台业务表。
-- 日常仍可用 npm run db:push 同步结构；本文件供本次要求的集中 SQL 上线使用，不使用 migrate deploy。
-- 在目标数据库同一连接执行整份文件，遇错停止（mysql 客户端不要加 --force）。
-- 需要 CREATE/ALTER/INDEX、临时部署存储过程的 CREATE ROUTINE/ALTER ROUTINE/EXECUTE 权限。
-- MySQL DDL 隐式提交；中途失败已建结构保留，修正问题后可以重跑，不清理业务数据。
-- 不删除表、列、索引；既有结构缺列或同名索引定义不符时停止，不静默覆盖。
-- 使用当前字段 ImageGenItem.deletedAt；不新增旧 chetaidouRemovedAt。
-- 若历史库有 chetaidouRemovedAt，仅把 CHETAIDOU 已删除记录补记到为空的 deletedAt，避免恢复已删结果。
-- 不新增历史文件中的 ImageGenItem(jobId,idx) 唯一索引，遵循当前 schema 的普通索引。
--
-- SQL 完成后：npx prisma generate && npm run build
-- 然后配置目标库/Spaces/模型参数，运行 npm run chetaidou:init -- --enable --dry-run；
-- 核对后以相同参数去掉 --dry-run 正式导入。首次模型参数见 scripts/chetaidou/README.md。
-- 初始化器负责结构化事实卡与来源全文、25 张已确认母版/拆解/缩略图、权限、扣费来源及模型。
-- 母版拆解写 PRESET/CONFIRMED 和确认审计；不执行历史事实卡修复或批量确认用户上传图。
SET NAMES utf8mb4;

DROP PROCEDURE IF EXISTS `chetaidou_deploy_20261008`;
DELIMITER $$
CREATE PROCEDURE `chetaidou_deploy_20261008`()
BEGIN
    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '请先选择目标业务数据库';
    END IF;
    IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('ImageGenJob', 'ImageGenItem')) <> 2 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '缺少基础生图表，请先用 db:push 安装平台基础结构';
    END IF;

    -- 1. 创建车泰斗 9 张业务表；既有记录原样保留。

    CREATE TABLE IF NOT EXISTS `ChetaidouSku` (
        `id` INTEGER NOT NULL AUTO_INCREMENT COMMENT '商品SKU自增ID',
        `code` VARCHAR(50) NOT NULL COMMENT '商品内部唯一编码，例如CS1plus',
        `name` VARCHAR(200) NOT NULL COMMENT '商品展示名称',
        `enabled` BOOLEAN NOT NULL DEFAULT false COMMENT '商品是否启用，资料初始化完成后才允许创建任务',
        `currentFactId` INTEGER NULL COMMENT '当前生效的ChetaidouFactCard事实卡ID',
        `revision` INTEGER NOT NULL DEFAULT 0 COMMENT '乐观锁版本号，用于检测并发修改',
        `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '记录创建时间',
        `updatedAt` DATETIME(3) NOT NULL COMMENT '记录最后更新时间，由服务端维护',

        UNIQUE INDEX `ChetaidouSku_code_key`(`code`),
        PRIMARY KEY (`id`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS `ChetaidouFactCard` (
        `id` INTEGER NOT NULL AUTO_INCREMENT COMMENT '事实卡自增ID',
        `skuId` INTEGER NOT NULL COMMENT '所属商品SKU ID',
        `version` INTEGER NOT NULL COMMENT '同一SKU内递增的事实卡版本',
        `content` JSON NOT NULL COMMENT '结构化产品事实、规则、来源信息及文档全文',
        `contentHash` VARCHAR(64) NOT NULL COMMENT '内容SHA-256哈希，用于完整性和版本校验',
        `confirmedBy` INTEGER NOT NULL COMMENT '确认操作人ID，系统初始化为0',
        `confirmedAt` DATETIME(3) NOT NULL COMMENT '确认时间',
        `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '记录创建时间',
        `updatedAt` DATETIME(3) NOT NULL COMMENT '记录最后更新时间，由服务端维护',

        UNIQUE INDEX `ChetaidouFactCard_skuId_version_key`(`skuId`, `version`),
        PRIMARY KEY (`id`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS `ChetaidouImage` (
        `id` INTEGER NOT NULL AUTO_INCREMENT COMMENT '母版图片自增ID',
        `skuId` INTEGER NOT NULL COMMENT '所属商品SKU ID',
        `sourceType` VARCHAR(20) NOT NULL COMMENT '图片来源：PRESET预置母版、USER_UPLOAD用户上传',
        `ownerId` INTEGER NULL COMMENT '图片所属用户ID，预置母版为空',
        `createdBy` INTEGER NOT NULL COMMENT '创建操作人ID，系统初始化为0',
        `title` VARCHAR(200) NOT NULL COMMENT '母版标题',
        `number` VARCHAR(100) NULL COMMENT '母版编号，用于展示和搜索',
        `fileKey` VARCHAR(1000) NOT NULL COMMENT '原图在Spaces中的对象key',
        `mime` VARCHAR(100) NOT NULL COMMENT '原图MIME类型，例如image/png',
        `width` INTEGER NOT NULL COMMENT '原图宽度，单位像素',
        `height` INTEGER NOT NULL COMMENT '原图高度，单位像素',
        `checksum` VARCHAR(64) NOT NULL COMMENT '原图文件SHA-256哈希',
        `enabled` BOOLEAN NOT NULL DEFAULT true COMMENT '母版是否可用',
        `revision` INTEGER NOT NULL DEFAULT 0 COMMENT '乐观锁版本号，用于检测并发修改',
        `currentBreakdownId` INTEGER NULL COMMENT '当前生效的ChetaidouBreakdown拆解ID',
        `activeBreakdownTaskId` VARCHAR(36) NULL COMMENT '正在执行的拆解任务ID，用于并发占位',
        `importKey` VARCHAR(191) NULL COMMENT '离线导入幂等键，防止重复登记',
        `sourceMetadata` JSON NULL COMMENT '来源审计信息，含原始目录及缩略图对象key',
        `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '记录创建时间',
        `updatedAt` DATETIME(3) NOT NULL COMMENT '记录最后更新时间，由服务端维护',

        UNIQUE INDEX `ChetaidouImage_importKey_key`(`importKey`),
        INDEX `ChetaidouImage_skuId_sourceType_ownerId_enabled_id_idx`(`skuId`, `sourceType`, `ownerId`, `enabled`, `id`),
        PRIMARY KEY (`id`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS `ChetaidouBreakdown` (
        `id` INTEGER NOT NULL AUTO_INCREMENT COMMENT '拆解记录自增ID',
        `imageId` INTEGER NOT NULL COMMENT '所属母版图片ID',
        `version` INTEGER NOT NULL COMMENT '同一母版内递增的拆解版本',
        `factId` INTEGER NOT NULL COMMENT '本次拆解依据的ChetaidouFactCard事实卡ID',
        `source` VARCHAR(10) NOT NULL COMMENT '拆解来源：PRESET预置确认稿、AI模型生成稿',
        `qualityStatus` VARCHAR(20) NOT NULL COMMENT '拆解状态：CONFIRMED已确认、AI_UNREVIEWED未人工确认、INVALID已失效',
        `payload` JSON NOT NULL COMMENT '结构化拆解内容，含人物、文字、货篮、约束、冲突及未知事项',
        `schemaVersion` INTEGER NOT NULL COMMENT 'JSON内容结构版本',
        `contentHash` VARCHAR(64) NOT NULL COMMENT '内容SHA-256哈希，用于完整性和版本校验',
        `confirmedBy` INTEGER NULL COMMENT '确认操作人ID，系统初始化为0',
        `confirmedAt` DATETIME(3) NULL COMMENT '确认时间',
        `importKey` VARCHAR(191) NULL COMMENT '离线导入幂等键，防止重复登记',
        `sourceMetadata` JSON NULL COMMENT '拆解来源与确认审计信息，保留历史原稿和缺失字段说明',
        `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '记录创建时间',
        `updatedAt` DATETIME(3) NOT NULL COMMENT '记录最后更新时间，由服务端维护',

        UNIQUE INDEX `ChetaidouBreakdown_importKey_key`(`importKey`),
        UNIQUE INDEX `ChetaidouBreakdown_imageId_version_key`(`imageId`, `version`),
        PRIMARY KEY (`id`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS `ChetaidouDraft` (
        `id` INTEGER NOT NULL AUTO_INCREMENT COMMENT '用户草稿自增ID',
        `ownerId` INTEGER NOT NULL COMMENT '所属用户ID',
        `imageId` INTEGER NOT NULL COMMENT '所属母版图片ID',
        `revision` INTEGER NOT NULL DEFAULT 0 COMMENT '乐观锁版本号，用于检测并发修改',
        `workspaceId` VARCHAR(36) NULL COMMENT '当前工作区令牌，用于隔离过期请求和异步写回',
        `activeAdjustmentId` VARCHAR(36) NULL COMMENT '当前正在编辑的调整历史ID',
        `restoredFromAdjustmentId` VARCHAR(36) NULL COMMENT '当前工作副本恢复来源历史ID',
        `settings` JSON NOT NULL COMMENT '当前表单设置，含站点、文字、人物及生成参数',
        `selections` JSON NOT NULL COMMENT '当前选项选择，含维度组ID、选项key及自定义文字',
        `customDimensions` JSON NOT NULL COMMENT '用户自建维度、选项及选择状态',
        `acknowledgedBreakdownId` INTEGER NULL COMMENT '用户确认过的拆解ID，保留历史确认审计',
        `activeIdeationTaskId` VARCHAR(36) NULL COMMENT '当前联想根任务ID',
        `activeCompositionTaskId` VARCHAR(36) NULL COMMENT '当前组合根任务ID',
        `activeGroupRefs` JSON NULL COMMENT '当前联想维度组的有序ID引用，刷新只替换对应组',
        `pendingRefreshTaskId` VARCHAR(36) NULL COMMENT '当前尚未终结的维度刷新任务ID',
        `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '记录创建时间',
        `updatedAt` DATETIME(3) NOT NULL COMMENT '记录最后更新时间，由服务端维护',

        UNIQUE INDEX `ChetaidouDraft_ownerId_imageId_key`(`ownerId`, `imageId`),
        PRIMARY KEY (`id`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS `ChetaidouAdjustment` (
        `id` VARCHAR(36) NOT NULL COMMENT '调整历史ID（UUID）',
        `ownerId` INTEGER NOT NULL COMMENT '所属用户ID',
        `skuId` INTEGER NOT NULL COMMENT '所属商品SKU ID',
        `imageId` INTEGER NOT NULL COMMENT '所属母版图片ID',
        `parentAdjustmentId` VARCHAR(36) NULL COMMENT '来源调整历史ID，恢复后新操作分叉时记录',
        `state` JSON NOT NULL COMMENT '调整状态快照（设置、选择、自建维度、组引用及任务指针）',
        `schemaVersion` INTEGER NOT NULL DEFAULT 1 COMMENT '调整状态JSON结构版本',
        `revision` INTEGER NOT NULL DEFAULT 0 COMMENT '调整历史版本号，与草稿版本独立',
        `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '调整历史创建时间',
        `updatedAt` DATETIME(3) NOT NULL COMMENT '调整历史最后更新时间',

        INDEX `ChetaidouAdjustment_ownerId_imageId_createdAt_id_idx`(`ownerId`, `imageId`, `createdAt`, `id`),
        INDEX `ChetaidouAdjustment_ownerId_skuId_createdAt_id_idx`(`ownerId`, `skuId`, `createdAt`, `id`),
        PRIMARY KEY (`id`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS `ChetaidouTask` (
        `id` VARCHAR(36) NOT NULL COMMENT '工作流任务ID（UUID）',
        `rootTaskId` VARCHAR(36) NOT NULL COMMENT '根任务ID，根任务自身为当前id',
        `parentTaskId` VARCHAR(36) NULL COMMENT '上轮组合任务ID，用于串联冲突问答轮次',
        `retryOfTaskId` VARCHAR(36) NULL COMMENT '本次重试对应的原根任务ID',
        `imageGenJobId` VARCHAR(36) NULL COMMENT 'GENERATE任务关联的生图批次ImageGenJob ID',
        `ownerId` INTEGER NOT NULL COMMENT '所属用户ID',
        `skuId` INTEGER NOT NULL COMMENT '所属商品SKU ID',
        `imageId` INTEGER NOT NULL COMMENT '所属母版图片ID',
        `workspaceId` VARCHAR(36) NULL COMMENT '任务提交时的工作区令牌',
        `adjustmentId` VARCHAR(36) NULL COMMENT '任务所属调整历史ID，重试沿用原归属',
        `site` VARCHAR(30) NULL COMMENT '任务提交时冻结的目标站点',
        `type` VARCHAR(20) NOT NULL COMMENT '任务类型：BREAKDOWN/IDEATION/REFRESH_GROUP/DIVERGE/COMPOSE/GENERATE',
        `operation` VARCHAR(10) NOT NULL DEFAULT 'PRIMARY' COMMENT '操作类型：PRIMARY首次提交、RETRY手动重试',
        `status` VARCHAR(32) NULL COMMENT '文本任务状态：QUEUED/RUNNING/WAITING_RECONCILIATION/SUCCEEDED/PARTIAL/FAILED/CANCELLED；GENERATE为空并读取Job状态',
        `stage` VARCHAR(64) NULL COMMENT '当前执行阶段标识',
        `idempotencyKey` VARCHAR(36) NOT NULL COMMENT '用户请求幂等键，同一用户下唯一',
        `requestHash` VARCHAR(64) NOT NULL COMMENT '标准化命令SHA-256哈希，同一幂等键不同内容返回冲突',
        `contextHash` VARCHAR(64) NULL COMMENT '阶段上下文指纹，用于识别设置或资料过期',
        `snapshot` JSON NOT NULL COMMENT '冻结的完整执行输入，含模型、事实卡、拆解、设置和提示词',
        `input` JSON NOT NULL COMMENT '本次操作的命令入参',
        `output` JSON NULL COMMENT '组合结果、刷新应用状态或拆解结果引用等任务产物',
        `progress` JSON NULL COMMENT '执行进度：total/processed/succeeded/failed',
        `acceptedDraftRevision` INTEGER NULL COMMENT '提交任务时接受的草稿版本号',
        `appliedDraftRevision` INTEGER NULL COMMENT '任务结果写回后的草稿版本号',
        `appliedAt` DATETIME(3) NULL COMMENT '任务结果应用到草稿或历史的时间',
        `cancelRequestedAt` DATETIME(3) NULL COMMENT '用户请求取消的时间',
        `errorCode` VARCHAR(64) NULL COMMENT '结构化错误码，正常时为空',
        `errorMessage` VARCHAR(1000) NULL COMMENT '错误详情，正常时为空',
        `finishedAt` DATETIME(3) NULL COMMENT '处理完成时间',
        `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '记录创建时间',
        `updatedAt` DATETIME(3) NOT NULL COMMENT '记录最后更新时间，由服务端维护',

        INDEX `ChetaidouTask_status_createdAt_idx`(`status`, `createdAt`),
        INDEX `ChetaidouTask_ownerId_createdAt_id_idx`(`ownerId`, `createdAt`, `id`),
        INDEX `ChetaidouTask_rootTaskId_idx`(`rootTaskId`),
        INDEX `ChetaidouTask_imageGenJobId_idx`(`imageGenJobId`),
        INDEX `ChetaidouTask_parentTaskId_idx`(`parentTaskId`),
        INDEX `ChetaidouTask_ownerId_imageId_type_createdAt_idx`(`ownerId`, `imageId`, `type`, `createdAt`),
        INDEX `ChetaidouTask_ownerId_skuId_site_createdAt_id_idx`(`ownerId`, `skuId`, `site`, `createdAt`, `id`),
        INDEX `ChetaidouTask_adjustmentId_createdAt_id_idx`(`adjustmentId`, `createdAt`, `id`),
        UNIQUE INDEX `ChetaidouTask_ownerId_idempotencyKey_key`(`ownerId`, `idempotencyKey`),
        PRIMARY KEY (`id`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS `ChetaidouGroup` (
        `id` VARCHAR(36) NOT NULL COMMENT '不可变维度组版本ID（UUID）',
        `taskId` VARCHAR(36) NOT NULL COMMENT '生成本组版本的联想或刷新任务ID',
        `parentGroupId` VARCHAR(36) NULL COMMENT '被刷新的来源维度组ID',
        `key` VARCHAR(100) NOT NULL COMMENT '任务内唯一的维度标识',
        `definition` JSON NOT NULL COMMENT '冻结的维度定义，含目标元素、属性、选择模式及当前值',
        `options` JSON NULL COMMENT '结构化候选选项，包含服务端生成的选择标识',
        `status` VARCHAR(20) NOT NULL COMMENT '维度组状态：PENDING/RUNNING/SETTLING/SUCCEEDED/FAILED/CANCELLED/UNKNOWN',
        `currentCallId` VARCHAR(36) NULL COMMENT '当前有效的ChetaidouCall调用ID',
        `errorCode` VARCHAR(64) NULL COMMENT '结构化错误码，正常时为空',
        `errorMessage` VARCHAR(1000) NULL COMMENT '错误详情，正常时为空',
        `order` INTEGER NOT NULL COMMENT '维度组展示顺序',
        `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '记录创建时间',
        `updatedAt` DATETIME(3) NOT NULL COMMENT '记录最后更新时间，由服务端维护',

        INDEX `ChetaidouGroup_taskId_order_idx`(`taskId`, `order`),
        UNIQUE INDEX `ChetaidouGroup_taskId_key_key`(`taskId`, `key`),
        PRIMARY KEY (`id`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS `ChetaidouCall` (
        `id` VARCHAR(36) NOT NULL COMMENT '单次模型调用ID（UUID）',
        `taskId` VARCHAR(36) NOT NULL COMMENT '发起本次调用的任务ID',
        `rootTaskId` VARCHAR(36) NOT NULL COMMENT '所属根任务ID',
        `ownerId` INTEGER NOT NULL COMMENT '所属用户ID',
        `targetKey` VARCHAR(100) NOT NULL COMMENT '调用目标标识，例如breakdown、group维度、compose或image图片项',
        `groupId` VARCHAR(36) NULL COMMENT '关联维度组ID，非维度调用时为空',
        `imageGenItemId` INTEGER NULL COMMENT '关联生图结果项ID，非图片调用时为空',
        `attempt` INTEGER NOT NULL COMMENT '同任务同目标的新付费调用序号，从1递增',
        `kind` VARCHAR(10) NOT NULL COMMENT '调用类型：TEXT文本、IMAGE图片',
        `source` VARCHAR(50) NOT NULL COMMENT '扣费来源：chetaidou.breakdown/ideation/diverge/compose/image',
        `model` VARCHAR(100) NOT NULL COMMENT '调用时冻结的网关模型publicId',
        `category` VARCHAR(50) NULL COMMENT '调用时冻结的模型业务分类',
        `promptVersion` VARCHAR(100) NOT NULL COMMENT '调用使用的提示词版本',
        `request` JSON NULL COMMENT '发出前保存的网关请求，可含临时签名URL，仅限受限读取',
        `requestHash` VARCHAR(64) NULL COMMENT '标准化请求SHA-256哈希',
        `providerIdempotencyKey` VARCHAR(100) NOT NULL COMMENT '网关提交幂等键，格式chetaidou:call:调用ID',
        `gatewayTaskId` VARCHAR(191) NULL COMMENT '网关异步任务ID，唯一关联',
        `gatewayRequestId` VARCHAR(191) NULL COMMENT '网关请求ID，用于查账和对账，唯一关联',
        `state` VARCHAR(20) NOT NULL COMMENT '调用状态：PREPARED/SUBMITTING/WAITING/RECEIVED/UNKNOWN/FINISHED',
        `outcome` VARCHAR(20) NULL COMMENT '结果：ACCEPTED/INVALID/PROVIDER_FAILED/CANCELLED/DELIVERY_FAILED',
        `billingStatus` VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT '结算状态：PENDING待结算、SETTLED已结算、FREE免费、REVIEW待核对',
        `gatewayResponse` JSON NULL COMMENT '网关原始回执，按冻结规则恢复解析，仅限受限读取',
        `usage` JSON NULL COMMENT '网关用量和账单明细',
        `estimatedSaleCny` DECIMAL(18, 8) NOT NULL DEFAULT 0 COMMENT '估算售价（人民币），审计字段；实际按账单结算',
        `gatewayAmountCny` DECIMAL(18, 8) NULL COMMENT '网关实际账单金额，单位人民币元',
        `pricing` JSON NULL COMMENT '首次结算的价格快照，含模式、模型、倍率及固定积分',
        `chargedCredits` DECIMAL(18, 4) NULL COMMENT '本次实际扣除的积分',
        `artifactFileKey` VARCHAR(1000) NULL COMMENT '交付产物在Spaces中的对象key',
        `submittedAt` DATETIME(3) NULL COMMENT '开始提交网关请求的时间',
        `receivedAt` DATETIME(3) NULL COMMENT '收到网关回执的时间',
        `finishedAt` DATETIME(3) NULL COMMENT '处理完成时间',
        `errorCode` VARCHAR(64) NULL COMMENT '结构化错误码，正常时为空',
        `errorMessage` VARCHAR(1000) NULL COMMENT '错误详情，正常时为空',
        `resolution` JSON NULL COMMENT '人工核对记录，含操作人、凭据、原因及时间',
        `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '记录创建时间',
        `updatedAt` DATETIME(3) NOT NULL COMMENT '记录最后更新时间，由服务端维护',

        UNIQUE INDEX `ChetaidouCall_gatewayTaskId_key`(`gatewayTaskId`),
        UNIQUE INDEX `ChetaidouCall_gatewayRequestId_key`(`gatewayRequestId`),
        INDEX `ChetaidouCall_state_createdAt_idx`(`state`, `createdAt`),
        INDEX `ChetaidouCall_billingStatus_createdAt_idx`(`billingStatus`, `createdAt`),
        INDEX `ChetaidouCall_rootTaskId_idx`(`rootTaskId`),
        INDEX `ChetaidouCall_imageGenItemId_idx`(`imageGenItemId`),
        UNIQUE INDEX `ChetaidouCall_taskId_targetKey_attempt_key`(`taskId`, `targetKey`, `attempt`),
        UNIQUE INDEX `ChetaidouCall_providerIdempotencyKey_key`(`providerIdempotencyKey`),
        PRIMARY KEY (`id`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    -- 2. 为复用生图表补齐当前字段，存在时跳过。

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND COLUMN_NAME = 'businessType') THEN
        ALTER TABLE `ImageGenJob` ADD COLUMN `businessType` VARCHAR(32) NOT NULL DEFAULT 'IMAGE_CREATIVE' COMMENT '业务来源：IMAGE_CREATIVE通用生图、CHETAIDOU车泰斗，用于执行与清理隔离';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND COLUMN_NAME = 'businessTaskId') THEN
        ALTER TABLE `ImageGenJob` ADD COLUMN `businessTaskId` VARCHAR(36) NULL COMMENT '关联车泰斗GENERATE根任务ID，通用生图为空';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND COLUMN_NAME = 'cancelRequestedAt') THEN
        ALTER TABLE `ImageGenJob` ADD COLUMN `cancelRequestedAt` DATETIME(3) NULL COMMENT '车泰斗生图批次请求取消时间';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'currentCallId') THEN
        ALTER TABLE `ImageGenItem` ADD COLUMN `currentCallId` VARCHAR(36) NULL COMMENT '当前有效的ChetaidouCall调用ID';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'fileKey') THEN
        ALTER TABLE `ImageGenItem` ADD COLUMN `fileKey` VARCHAR(1000) NULL COMMENT '车泰斗私有成品在Spaces中的对象key';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'mime') THEN
        ALTER TABLE `ImageGenItem` ADD COLUMN `mime` VARCHAR(100) NULL COMMENT '私有成品MIME类型';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'width') THEN
        ALTER TABLE `ImageGenItem` ADD COLUMN `width` INTEGER NULL COMMENT '私有成品宽度，单位像素';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'height') THEN
        ALTER TABLE `ImageGenItem` ADD COLUMN `height` INTEGER NULL COMMENT '私有成品高度，单位像素';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'errorCode') THEN
        ALTER TABLE `ImageGenItem` ADD COLUMN `errorCode` VARCHAR(64) NULL COMMENT '生图或交付失败的结构化错误码';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'deletedAt') THEN
        ALTER TABLE `ImageGenItem` ADD COLUMN `deletedAt` DATETIME(3) NULL COMMENT '结果软删除时间，仅影响展示、下载和重试，保留结算记录';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'gatewayImage') THEN
        ALTER TABLE `ImageGenItem` ADD COLUMN `gatewayImage` JSON NULL COMMENT '网关原图、任务关联与交付元数据，用于原图查看和审计';
    END IF;

    -- CHETAIDOU 产物持久保留，expiresAt 必须允许 NULL。
    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND COLUMN_NAME = 'expiresAt'
        AND DATA_TYPE = 'datetime' AND DATETIME_PRECISION = 3) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenJob.expiresAt 类型不匹配，请核对基础表结构';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND COLUMN_NAME = 'expiresAt' AND IS_NULLABLE = 'NO') THEN
        ALTER TABLE `ImageGenJob` MODIFY COLUMN `expiresAt` DATETIME(3) NULL COMMENT '通用生图查询过期时间；车泰斗持久保留，为NULL';
    END IF;

    -- 3. 校验必需列，避免已存在但不完整的表被当成安装成功。

    IF (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouSku' AND COLUMN_NAME IN ('id', 'code', 'name', 'enabled', 'currentFactId', 'revision', 'createdAt', 'updatedAt')) <> 8 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouSku 既有结构缺少必需列，请先核对差异';
    END IF;

    IF (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouFactCard' AND COLUMN_NAME IN ('id', 'skuId', 'version', 'content', 'contentHash', 'confirmedBy', 'confirmedAt', 'createdAt', 'updatedAt')) <> 9 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouFactCard 既有结构缺少必需列，请先核对差异';
    END IF;

    IF (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouImage' AND COLUMN_NAME IN ('id', 'skuId', 'sourceType', 'ownerId', 'createdBy', 'title', 'number', 'fileKey', 'mime', 'width', 'height', 'checksum', 'enabled', 'revision', 'currentBreakdownId', 'activeBreakdownTaskId', 'importKey', 'sourceMetadata', 'createdAt', 'updatedAt')) <> 20 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouImage 既有结构缺少必需列，请先核对差异';
    END IF;

    IF (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouBreakdown' AND COLUMN_NAME IN ('id', 'imageId', 'version', 'factId', 'source', 'qualityStatus', 'payload', 'schemaVersion', 'contentHash', 'confirmedBy', 'confirmedAt', 'importKey', 'sourceMetadata', 'createdAt', 'updatedAt')) <> 15 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouBreakdown 既有结构缺少必需列，请先核对差异';
    END IF;

    IF (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouDraft' AND COLUMN_NAME IN ('id', 'ownerId', 'imageId', 'revision', 'workspaceId', 'activeAdjustmentId', 'restoredFromAdjustmentId', 'settings', 'selections', 'customDimensions', 'acknowledgedBreakdownId', 'activeIdeationTaskId', 'activeCompositionTaskId', 'activeGroupRefs', 'pendingRefreshTaskId', 'createdAt', 'updatedAt')) <> 17 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouDraft 既有结构缺少必需列，请先核对差异';
    END IF;

    IF (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouAdjustment' AND COLUMN_NAME IN ('id', 'ownerId', 'skuId', 'imageId', 'parentAdjustmentId', 'state', 'schemaVersion', 'revision', 'createdAt', 'updatedAt')) <> 10 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouAdjustment 既有结构缺少必需列，请先核对差异';
    END IF;

    IF (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND COLUMN_NAME IN ('id', 'rootTaskId', 'parentTaskId', 'retryOfTaskId', 'imageGenJobId', 'ownerId', 'skuId', 'imageId', 'workspaceId', 'adjustmentId', 'site', 'type', 'operation', 'status', 'stage', 'idempotencyKey', 'requestHash', 'contextHash', 'snapshot', 'input', 'output', 'progress', 'acceptedDraftRevision', 'appliedDraftRevision', 'appliedAt', 'cancelRequestedAt', 'errorCode', 'errorMessage', 'finishedAt', 'createdAt', 'updatedAt')) <> 31 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouTask 既有结构缺少必需列，请先核对差异';
    END IF;

    IF (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouGroup' AND COLUMN_NAME IN ('id', 'taskId', 'parentGroupId', 'key', 'definition', 'options', 'status', 'currentCallId', 'errorCode', 'errorMessage', 'order', 'createdAt', 'updatedAt')) <> 13 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouGroup 既有结构缺少必需列，请先核对差异';
    END IF;

    IF (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND COLUMN_NAME IN ('id', 'taskId', 'rootTaskId', 'ownerId', 'targetKey', 'groupId', 'imageGenItemId', 'attempt', 'kind', 'source', 'model', 'category', 'promptVersion', 'request', 'requestHash', 'providerIdempotencyKey', 'gatewayTaskId', 'gatewayRequestId', 'state', 'outcome', 'billingStatus', 'gatewayResponse', 'usage', 'estimatedSaleCny', 'gatewayAmountCny', 'pricing', 'chargedCredits', 'artifactFileKey', 'submittedAt', 'receivedAt', 'finishedAt', 'errorCode', 'errorMessage', 'resolution', 'createdAt', 'updatedAt')) <> 36 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouCall 既有结构缺少必需列，请先核对差异';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND COLUMN_NAME = 'businessType' AND DATA_TYPE = 'varchar' AND CHARACTER_MAXIMUM_LENGTH = 32 AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT = 'IMAGE_CREATIVE') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenJob.businessType 既有定义不匹配，请核对';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND COLUMN_NAME = 'businessTaskId' AND DATA_TYPE = 'varchar' AND CHARACTER_MAXIMUM_LENGTH = 36 AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenJob.businessTaskId 既有定义不匹配，请核对';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND COLUMN_NAME = 'cancelRequestedAt' AND DATA_TYPE = 'datetime' AND DATETIME_PRECISION = 3 AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenJob.cancelRequestedAt 既有定义不匹配，请核对';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'currentCallId' AND DATA_TYPE = 'varchar' AND CHARACTER_MAXIMUM_LENGTH = 36 AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenItem.currentCallId 既有定义不匹配，请核对';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'fileKey' AND DATA_TYPE = 'varchar' AND CHARACTER_MAXIMUM_LENGTH = 1000 AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenItem.fileKey 既有定义不匹配，请核对';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'mime' AND DATA_TYPE = 'varchar' AND CHARACTER_MAXIMUM_LENGTH = 100 AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenItem.mime 既有定义不匹配，请核对';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'width' AND DATA_TYPE = 'int' AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenItem.width 既有定义不匹配，请核对';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'height' AND DATA_TYPE = 'int' AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenItem.height 既有定义不匹配，请核对';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'errorCode' AND DATA_TYPE = 'varchar' AND CHARACTER_MAXIMUM_LENGTH = 64 AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenItem.errorCode 既有定义不匹配，请核对';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'deletedAt' AND DATA_TYPE = 'datetime' AND DATETIME_PRECISION = 3 AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenItem.deletedAt 既有定义不匹配，请核对';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'gatewayImage' AND DATA_TYPE = 'json' AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenItem.gatewayImage 既有定义不匹配，请核对';
    END IF;

    -- 4. 补齐 schema 声明的索引，同名定义不一致时停止。

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouSku' AND INDEX_NAME = 'ChetaidouSku_code_key') THEN
        ALTER TABLE `ChetaidouSku` ADD UNIQUE INDEX `ChetaidouSku_code_key`(`code`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouSku' AND INDEX_NAME = 'ChetaidouSku_code_key'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'code'
        AND MIN(NON_UNIQUE) = 0 AND MAX(NON_UNIQUE) = 0 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouSku_code_key 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouFactCard' AND INDEX_NAME = 'ChetaidouFactCard_skuId_version_key') THEN
        ALTER TABLE `ChetaidouFactCard` ADD UNIQUE INDEX `ChetaidouFactCard_skuId_version_key`(`skuId`, `version`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouFactCard' AND INDEX_NAME = 'ChetaidouFactCard_skuId_version_key'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'skuId,version'
        AND MIN(NON_UNIQUE) = 0 AND MAX(NON_UNIQUE) = 0 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouFactCard_skuId_version_key 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouImage' AND INDEX_NAME = 'ChetaidouImage_importKey_key') THEN
        ALTER TABLE `ChetaidouImage` ADD UNIQUE INDEX `ChetaidouImage_importKey_key`(`importKey`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouImage' AND INDEX_NAME = 'ChetaidouImage_importKey_key'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'importKey'
        AND MIN(NON_UNIQUE) = 0 AND MAX(NON_UNIQUE) = 0 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouImage_importKey_key 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouImage' AND INDEX_NAME = 'ChetaidouImage_skuId_sourceType_ownerId_enabled_id_idx') THEN
        ALTER TABLE `ChetaidouImage` ADD INDEX `ChetaidouImage_skuId_sourceType_ownerId_enabled_id_idx`(`skuId`, `sourceType`, `ownerId`, `enabled`, `id`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouImage' AND INDEX_NAME = 'ChetaidouImage_skuId_sourceType_ownerId_enabled_id_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'skuId,sourceType,ownerId,enabled,id'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouImage_skuId_sourceType_ownerId_enabled_id_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouBreakdown' AND INDEX_NAME = 'ChetaidouBreakdown_importKey_key') THEN
        ALTER TABLE `ChetaidouBreakdown` ADD UNIQUE INDEX `ChetaidouBreakdown_importKey_key`(`importKey`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouBreakdown' AND INDEX_NAME = 'ChetaidouBreakdown_importKey_key'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'importKey'
        AND MIN(NON_UNIQUE) = 0 AND MAX(NON_UNIQUE) = 0 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouBreakdown_importKey_key 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouBreakdown' AND INDEX_NAME = 'ChetaidouBreakdown_imageId_version_key') THEN
        ALTER TABLE `ChetaidouBreakdown` ADD UNIQUE INDEX `ChetaidouBreakdown_imageId_version_key`(`imageId`, `version`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouBreakdown' AND INDEX_NAME = 'ChetaidouBreakdown_imageId_version_key'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'imageId,version'
        AND MIN(NON_UNIQUE) = 0 AND MAX(NON_UNIQUE) = 0 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouBreakdown_imageId_version_key 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouDraft' AND INDEX_NAME = 'ChetaidouDraft_ownerId_imageId_key') THEN
        ALTER TABLE `ChetaidouDraft` ADD UNIQUE INDEX `ChetaidouDraft_ownerId_imageId_key`(`ownerId`, `imageId`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouDraft' AND INDEX_NAME = 'ChetaidouDraft_ownerId_imageId_key'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'ownerId,imageId'
        AND MIN(NON_UNIQUE) = 0 AND MAX(NON_UNIQUE) = 0 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouDraft_ownerId_imageId_key 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_status_createdAt_idx') THEN
        ALTER TABLE `ChetaidouTask` ADD INDEX `ChetaidouTask_status_createdAt_idx`(`status`, `createdAt`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_status_createdAt_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'status,createdAt'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouTask_status_createdAt_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_ownerId_createdAt_id_idx') THEN
        ALTER TABLE `ChetaidouTask` ADD INDEX `ChetaidouTask_ownerId_createdAt_id_idx`(`ownerId`, `createdAt`, `id`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_ownerId_createdAt_id_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'ownerId,createdAt,id'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouTask_ownerId_createdAt_id_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_rootTaskId_idx') THEN
        ALTER TABLE `ChetaidouTask` ADD INDEX `ChetaidouTask_rootTaskId_idx`(`rootTaskId`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_rootTaskId_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'rootTaskId'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouTask_rootTaskId_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_imageGenJobId_idx') THEN
        ALTER TABLE `ChetaidouTask` ADD INDEX `ChetaidouTask_imageGenJobId_idx`(`imageGenJobId`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_imageGenJobId_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'imageGenJobId'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouTask_imageGenJobId_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_parentTaskId_idx') THEN
        ALTER TABLE `ChetaidouTask` ADD INDEX `ChetaidouTask_parentTaskId_idx`(`parentTaskId`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_parentTaskId_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'parentTaskId'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouTask_parentTaskId_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_ownerId_imageId_type_createdAt_idx') THEN
        ALTER TABLE `ChetaidouTask` ADD INDEX `ChetaidouTask_ownerId_imageId_type_createdAt_idx`(`ownerId`, `imageId`, `type`, `createdAt`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_ownerId_imageId_type_createdAt_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'ownerId,imageId,type,createdAt'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouTask_ownerId_imageId_type_createdAt_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_ownerId_idempotencyKey_key') THEN
        ALTER TABLE `ChetaidouTask` ADD UNIQUE INDEX `ChetaidouTask_ownerId_idempotencyKey_key`(`ownerId`, `idempotencyKey`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouTask' AND INDEX_NAME = 'ChetaidouTask_ownerId_idempotencyKey_key'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'ownerId,idempotencyKey'
        AND MIN(NON_UNIQUE) = 0 AND MAX(NON_UNIQUE) = 0 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouTask_ownerId_idempotencyKey_key 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouGroup' AND INDEX_NAME = 'ChetaidouGroup_taskId_order_idx') THEN
        ALTER TABLE `ChetaidouGroup` ADD INDEX `ChetaidouGroup_taskId_order_idx`(`taskId`, `order`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouGroup' AND INDEX_NAME = 'ChetaidouGroup_taskId_order_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'taskId,order'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouGroup_taskId_order_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouGroup' AND INDEX_NAME = 'ChetaidouGroup_taskId_key_key') THEN
        ALTER TABLE `ChetaidouGroup` ADD UNIQUE INDEX `ChetaidouGroup_taskId_key_key`(`taskId`, `key`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouGroup' AND INDEX_NAME = 'ChetaidouGroup_taskId_key_key'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'taskId,key'
        AND MIN(NON_UNIQUE) = 0 AND MAX(NON_UNIQUE) = 0 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouGroup_taskId_key_key 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_gatewayTaskId_key') THEN
        ALTER TABLE `ChetaidouCall` ADD UNIQUE INDEX `ChetaidouCall_gatewayTaskId_key`(`gatewayTaskId`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_gatewayTaskId_key'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'gatewayTaskId'
        AND MIN(NON_UNIQUE) = 0 AND MAX(NON_UNIQUE) = 0 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouCall_gatewayTaskId_key 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_gatewayRequestId_key') THEN
        ALTER TABLE `ChetaidouCall` ADD UNIQUE INDEX `ChetaidouCall_gatewayRequestId_key`(`gatewayRequestId`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_gatewayRequestId_key'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'gatewayRequestId'
        AND MIN(NON_UNIQUE) = 0 AND MAX(NON_UNIQUE) = 0 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouCall_gatewayRequestId_key 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_state_createdAt_idx') THEN
        ALTER TABLE `ChetaidouCall` ADD INDEX `ChetaidouCall_state_createdAt_idx`(`state`, `createdAt`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_state_createdAt_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'state,createdAt'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouCall_state_createdAt_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_billingStatus_createdAt_idx') THEN
        ALTER TABLE `ChetaidouCall` ADD INDEX `ChetaidouCall_billingStatus_createdAt_idx`(`billingStatus`, `createdAt`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_billingStatus_createdAt_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'billingStatus,createdAt'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouCall_billingStatus_createdAt_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_rootTaskId_idx') THEN
        ALTER TABLE `ChetaidouCall` ADD INDEX `ChetaidouCall_rootTaskId_idx`(`rootTaskId`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_rootTaskId_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'rootTaskId'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouCall_rootTaskId_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_imageGenItemId_idx') THEN
        ALTER TABLE `ChetaidouCall` ADD INDEX `ChetaidouCall_imageGenItemId_idx`(`imageGenItemId`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_imageGenItemId_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'imageGenItemId'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouCall_imageGenItemId_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_taskId_targetKey_attempt_key') THEN
        ALTER TABLE `ChetaidouCall` ADD UNIQUE INDEX `ChetaidouCall_taskId_targetKey_attempt_key`(`taskId`, `targetKey`, `attempt`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_taskId_targetKey_attempt_key'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'taskId,targetKey,attempt'
        AND MIN(NON_UNIQUE) = 0 AND MAX(NON_UNIQUE) = 0 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouCall_taskId_targetKey_attempt_key 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_providerIdempotencyKey_key') THEN
        ALTER TABLE `ChetaidouCall` ADD UNIQUE INDEX `ChetaidouCall_providerIdempotencyKey_key`(`providerIdempotencyKey`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ChetaidouCall' AND INDEX_NAME = 'ChetaidouCall_providerIdempotencyKey_key'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'providerIdempotencyKey'
        AND MIN(NON_UNIQUE) = 0 AND MAX(NON_UNIQUE) = 0 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ChetaidouCall_providerIdempotencyKey_key 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND INDEX_NAME = 'ImageGenJob_businessTaskId_key') THEN
        ALTER TABLE `ImageGenJob` ADD UNIQUE INDEX `ImageGenJob_businessTaskId_key`(`businessTaskId`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND INDEX_NAME = 'ImageGenJob_businessTaskId_key'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'businessTaskId'
        AND MIN(NON_UNIQUE) = 0 AND MAX(NON_UNIQUE) = 0 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenJob_businessTaskId_key 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND INDEX_NAME = 'ImageGenJob_businessType_status_createdAt_idx') THEN
        ALTER TABLE `ImageGenJob` ADD INDEX `ImageGenJob_businessType_status_createdAt_idx`(`businessType`, `status`, `createdAt`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND INDEX_NAME = 'ImageGenJob_businessType_status_createdAt_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'businessType,status,createdAt'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenJob_businessType_status_createdAt_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND INDEX_NAME = 'ImageGenJob_businessType_userId_createdAt_idx') THEN
        ALTER TABLE `ImageGenJob` ADD INDEX `ImageGenJob_businessType_userId_createdAt_idx`(`businessType`, `userId`, `createdAt`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenJob' AND INDEX_NAME = 'ImageGenJob_businessType_userId_createdAt_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'businessType,userId,createdAt'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenJob_businessType_userId_createdAt_idx 定义不匹配';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND INDEX_NAME = 'ImageGenItem_jobId_idx_idx') THEN
        ALTER TABLE `ImageGenItem` ADD INDEX `ImageGenItem_jobId_idx_idx`(`jobId`, `idx`);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND INDEX_NAME = 'ImageGenItem_jobId_idx_idx'
        GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') = 'jobId,idx'
        AND MIN(NON_UNIQUE) = 1 AND MAX(NON_UNIQUE) = 1 AND COUNT(SUB_PART) = 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ImageGenItem_jobId_idx_idx 定义不匹配';
    END IF;

    -- 5. 仅兼容曾执行旧版预览墙增量 SQL 的环境，保留旧列供追溯。
    IF EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME = 'chetaidouRemovedAt') THEN
        SET @chetaidou_legacy_delete_sql = 'UPDATE `ImageGenItem` AS i JOIN `ImageGenJob` AS j ON j.id = i.jobId SET i.deletedAt = i.chetaidouRemovedAt WHERE j.businessType = ''CHETAIDOU'' AND i.deletedAt IS NULL AND i.chetaidouRemovedAt IS NOT NULL';
        PREPARE chetaidou_legacy_delete FROM @chetaidou_legacy_delete_sql;
        EXECUTE chetaidou_legacy_delete;
        DEALLOCATE PREPARE chetaidou_legacy_delete;
    END IF;
END$$
DELIMITER ;

CALL `chetaidou_deploy_20261008`();
DROP PROCEDURE `chetaidou_deploy_20261008`;

-- 仅 CALL 成功后继续初始化；以下结果用于核对目标库和当前结构。
SELECT DATABASE() AS target_database, '车泰斗结构已就绪；请继续运行资料初始化命令' AS result;
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN
('ChetaidouSku', 'ChetaidouFactCard', 'ChetaidouImage', 'ChetaidouBreakdown',
 'ChetaidouDraft', 'ChetaidouAdjustment', 'ChetaidouTask', 'ChetaidouGroup', 'ChetaidouCall') ORDER BY TABLE_NAME;
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
AND (TABLE_NAME LIKE 'Chetaidou%'
 OR (TABLE_NAME = 'ImageGenJob' AND COLUMN_NAME IN ('businessType', 'businessTaskId', 'cancelRequestedAt', 'expiresAt'))
 OR (TABLE_NAME = 'ImageGenItem' AND COLUMN_NAME IN ('currentCallId', 'fileKey', 'mime', 'width', 'height', 'errorCode', 'deletedAt', 'gatewayImage')))
ORDER BY TABLE_NAME, ORDINAL_POSITION;
