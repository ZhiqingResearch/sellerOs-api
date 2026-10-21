-- 车泰斗流程优化增量 SQL（2026-10-12），由用户自行执行。
-- 适用：已有 ChetaidouDraft / ChetaidouTask 的 MySQL 业务库。
-- 仅新增一张调整历史表、六个字段及四个索引，不回填/修改业务数据或模型价格。
-- 先选中目标数据库，再在同一连接执行整份文件；支持重复执行。
-- 需要 CREATE/ALTER/INDEX 及临时存储过程的 CREATE ROUTINE/ALTER ROUTINE/EXECUTE 权限。
-- MySQL DDL 隐式提交，遇错停止；修正后可以重跑，不要使用 mysql --force。
-- UUID 由 Prisma Client 生成；可空工作区/关联字段默认 NULL，不设置数据库 UUID 默认函数。
-- 字段说明使用数据库 COMMENT 保存；已执行过无注释版本时，重跑会补齐字段注释。
-- 执行完成后重新生成 Prisma Client 并构建：npm run generate；npm run build。

-- 使用 UTF-8 连接编码，确保中文错误提示和后续 JSON 内容正确处理。
SET NAMES utf8mb4;

-- 删除本脚本上次中断时可能留下的临时过程，不删除业务表。
DROP PROCEDURE IF EXISTS `chetaidou_workflow_20261012`;
-- 临时改用 $$ 分隔符，过程内部可使用 IF 和分号，结束后恢复为分号。
DELIMITER $$
CREATE PROCEDURE `chetaidou_workflow_20261012`()
BEGIN
    -- 1. 执行前检查：必须选中业务库，且已有旧版本的草稿和任务基础表。
    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '请先选择目标业务数据库';
    END IF;
    IF (SELECT COUNT(*) FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('ChetaidouDraft', 'ChetaidouTask')) <> 2 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '缺少车泰斗基础表，请先安装原车泰斗结构';
    END IF;

    -- 2. 调整历史表：首次提交联想时创建记录，未提交的表单仍只保存在草稿。
    -- 从历史恢复后修改并提交新文本操作，创建新记录，来源记录不被覆盖。
    -- IF NOT EXISTS 允许重复执行；本脚本不复制或回填旧草稿、任务。
    CREATE TABLE IF NOT EXISTS `ChetaidouAdjustment` (
        -- 历史记录 UUID，由服务端创建；不是 Task ID 或 ImageGenJob ID。
        `id` VARCHAR(36) NOT NULL COMMENT '调整历史ID（UUID）',
        -- 所属用户 ID，用于本人历史隔离和访问校验。
        `ownerId` INTEGER NOT NULL COMMENT '所属用户ID',
        -- 所属商品 SKU ID，用于商品维度的归属校验和历史查询。
        `skuId` INTEGER NOT NULL COMMENT '所属商品SKU ID',
        -- 所属母版图片 ID，一张母版可对应同一用户的多条调整记录。
        `imageId` INTEGER NOT NULL COMMENT '所属母版图片ID',
        -- 来源历史 ID；分叉记录指向原历史，首次创建时为空。
        `parentAdjustmentId` VARCHAR(36) NULL COMMENT '来源调整历史ID，恢复后新操作分叉时记录',
        -- 完整工作状态：设置、选择、自建维度、有效组引用、任务指针及资料版本。
        -- 组正文和实际任务状态仍读取 Group/Task，不在这里复制图片文件或签名 URL。
        `state` JSON NOT NULL COMMENT '调整状态快照（设置、选择、自建维度、组引用及任务指针）',
        -- 历史状态 JSON 的结构版本，当前固定从版本 1 开始。
        `schemaVersion` INTEGER NOT NULL DEFAULT 1 COMMENT '调整状态JSON结构版本',
        -- 历史状态的版本计数；与当前 Draft.revision 分开，不能替代草稿提交版本。
        `revision` INTEGER NOT NULL DEFAULT 0 COMMENT '调整历史版本号，与草稿版本独立',
        -- 历史首次创建时间，用于列表排序。
        `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '调整历史创建时间',
        -- 历史最后更新时间，由 Prisma 在保存或异步补齐产物时维护。
        `updatedAt` DATETIME(3) NOT NULL COMMENT '调整历史最后更新时间',

        -- 加速本人某张母版的历史分页，时间相同时使用 id 稳定排序。
        INDEX `ChetaidouAdjustment_ownerId_imageId_createdAt_id_idx`(`ownerId`, `imageId`, `createdAt`, `id`),
        -- 加速本人某个 SKU 下的历史查询。
        INDEX `ChetaidouAdjustment_ownerId_skuId_createdAt_id_idx`(`ownerId`, `skuId`, `createdAt`, `id`),
        PRIMARY KEY (`id`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

    -- 已存在的历史表也补齐 COMMENT；字段类型、可空性、默认值保持当前 Schema 定义。
    IF (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouAdjustment'
        AND COLUMN_COMMENT = CASE COLUMN_NAME
            WHEN 'id' THEN '调整历史ID（UUID）'
            WHEN 'ownerId' THEN '所属用户ID'
            WHEN 'skuId' THEN '所属商品SKU ID'
            WHEN 'imageId' THEN '所属母版图片ID'
            WHEN 'parentAdjustmentId' THEN '来源调整历史ID，恢复后新操作分叉时记录'
            WHEN 'state' THEN '调整状态快照（设置、选择、自建维度、组引用及任务指针）'
            WHEN 'schemaVersion' THEN '调整状态JSON结构版本'
            WHEN 'revision' THEN '调整历史版本号，与草稿版本独立'
            WHEN 'createdAt' THEN '调整历史创建时间'
            WHEN 'updatedAt' THEN '调整历史最后更新时间'
        END) <> 10 THEN
        ALTER TABLE `ChetaidouAdjustment`
            MODIFY COLUMN `id` VARCHAR(36) NOT NULL COMMENT '调整历史ID（UUID）',
            MODIFY COLUMN `ownerId` INTEGER NOT NULL COMMENT '所属用户ID',
            MODIFY COLUMN `skuId` INTEGER NOT NULL COMMENT '所属商品SKU ID',
            MODIFY COLUMN `imageId` INTEGER NOT NULL COMMENT '所属母版图片ID',
            MODIFY COLUMN `parentAdjustmentId` VARCHAR(36) NULL COMMENT '来源调整历史ID，恢复后新操作分叉时记录',
            MODIFY COLUMN `state` JSON NOT NULL COMMENT '调整状态快照（设置、选择、自建维度、组引用及任务指针）',
            MODIFY COLUMN `schemaVersion` INTEGER NOT NULL DEFAULT 1 COMMENT '调整状态JSON结构版本',
            MODIFY COLUMN `revision` INTEGER NOT NULL DEFAULT 0 COMMENT '调整历史版本号，与草稿版本独立',
            MODIFY COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '调整历史创建时间',
            MODIFY COLUMN `updatedAt` DATETIME(3) NOT NULL COMMENT '调整历史最后更新时间';
    END IF;

    -- 3. 草稿新增字段：每个字段先查系统目录，存在则跳过，支持中断后重跑。
    -- 当前工作区令牌：新建、恢复或重新联想时更换；配合 revision 拒绝旧页面写入。
    -- 旧行保持 NULL，GET draft 时由服务端按需分配令牌，不在 SQL 中回填。
    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouDraft' AND COLUMN_NAME = 'workspaceId') THEN
        ALTER TABLE `ChetaidouDraft` ADD COLUMN `workspaceId` VARCHAR(36) NULL COMMENT '当前工作区令牌，用于隔离过期请求和异步写回';
    ELSEIF EXISTS (SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouDraft' AND COLUMN_NAME = 'workspaceId'
        AND COLUMN_COMMENT <> '当前工作区令牌，用于隔离过期请求和异步写回') THEN
        ALTER TABLE `ChetaidouDraft` MODIFY COLUMN `workspaceId` VARCHAR(36) NULL COMMENT '当前工作区令牌，用于隔离过期请求和异步写回';
    END IF;
    -- 当前正在编辑的新历史记录 ID；首次联想前为空，恢复历史副本时也为空。
    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouDraft' AND COLUMN_NAME = 'activeAdjustmentId') THEN
        ALTER TABLE `ChetaidouDraft` ADD COLUMN `activeAdjustmentId` VARCHAR(36) NULL COMMENT '当前正在编辑的调整历史ID';
    ELSEIF EXISTS (SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouDraft' AND COLUMN_NAME = 'activeAdjustmentId'
        AND COLUMN_COMMENT <> '当前正在编辑的调整历史ID') THEN
        ALTER TABLE `ChetaidouDraft` MODIFY COLUMN `activeAdjustmentId` VARCHAR(36) NULL COMMENT '当前正在编辑的调整历史ID';
    END IF;
    -- 当前副本的恢复来源；编辑只改草稿，新的文本操作据此分叉，保留原历史。
    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouDraft' AND COLUMN_NAME = 'restoredFromAdjustmentId') THEN
        ALTER TABLE `ChetaidouDraft` ADD COLUMN `restoredFromAdjustmentId` VARCHAR(36) NULL COMMENT '当前工作副本恢复来源历史ID';
    ELSEIF EXISTS (SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouDraft' AND COLUMN_NAME = 'restoredFromAdjustmentId'
        AND COLUMN_COMMENT <> '当前工作副本恢复来源历史ID') THEN
        ALTER TABLE `ChetaidouDraft` MODIFY COLUMN `restoredFromAdjustmentId` VARCHAR(36) NULL COMMENT '当前工作副本恢复来源历史ID';
    END IF;
    -- 4. 任务新增字段：任务提交时冻结，不随用户切换草稿或站点改写。
    -- 提交任务时的工作区令牌；晚到产物不能写入令牌不匹配的新工作区。
    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouTask' AND COLUMN_NAME = 'workspaceId') THEN
        ALTER TABLE `ChetaidouTask` ADD COLUMN `workspaceId` VARCHAR(36) NULL COMMENT '任务提交时的工作区令牌';
    ELSEIF EXISTS (SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouTask' AND COLUMN_NAME = 'workspaceId'
        AND COLUMN_COMMENT <> '任务提交时的工作区令牌') THEN
        ALTER TABLE `ChetaidouTask` MODIFY COLUMN `workspaceId` VARCHAR(36) NULL COMMENT '任务提交时的工作区令牌';
    END IF;
    -- 任务所属历史 ID；重试复用原归属，拆解和尚未创建历史的任务可为空。
    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouTask' AND COLUMN_NAME = 'adjustmentId') THEN
        ALTER TABLE `ChetaidouTask` ADD COLUMN `adjustmentId` VARCHAR(36) NULL COMMENT '任务所属调整历史ID，重试沿用原归属';
    ELSEIF EXISTS (SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouTask' AND COLUMN_NAME = 'adjustmentId'
        AND COLUMN_COMMENT <> '任务所属调整历史ID，重试沿用原归属') THEN
        ALTER TABLE `ChetaidouTask` MODIFY COLUMN `adjustmentId` VARCHAR(36) NULL COMMENT '任务所属调整历史ID，重试沿用原归属';
    END IF;
    -- 提交时冻结的站点，例如 original/amazon_de；用于历史任务和结果筛选。
    -- 当前草稿改站点不会改变旧任务的站点；不回填历史任务的该字段。
    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouTask' AND COLUMN_NAME = 'site') THEN
        ALTER TABLE `ChetaidouTask` ADD COLUMN `site` VARCHAR(30) NULL COMMENT '任务提交时冻结的目标站点';
    ELSEIF EXISTS (SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouTask' AND COLUMN_NAME = 'site'
        AND COLUMN_COMMENT <> '任务提交时冻结的目标站点') THEN
        ALTER TABLE `ChetaidouTask` MODIFY COLUMN `site` VARCHAR(30) NULL COMMENT '任务提交时冻结的目标站点';
    END IF;

    -- 5. 补齐索引：即使历史表已存在，也按索引名检查，缺少时才创建。
    -- 本人 + 母版 + 创建时间 + id：母版历史查询与稳定分页。
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouAdjustment'
        AND INDEX_NAME = 'ChetaidouAdjustment_ownerId_imageId_createdAt_id_idx') THEN
        ALTER TABLE `ChetaidouAdjustment` ADD INDEX `ChetaidouAdjustment_ownerId_imageId_createdAt_id_idx`(`ownerId`, `imageId`, `createdAt`, `id`);
    END IF;
    -- 本人 + SKU + 创建时间 + id：SKU 历史查询与稳定分页。
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouAdjustment'
        AND INDEX_NAME = 'ChetaidouAdjustment_ownerId_skuId_createdAt_id_idx') THEN
        ALTER TABLE `ChetaidouAdjustment` ADD INDEX `ChetaidouAdjustment_ownerId_skuId_createdAt_id_idx`(`ownerId`, `skuId`, `createdAt`, `id`);
    END IF;
    -- 本人 + SKU + 冻结站点 + 创建时间 + id：任务列表的站点筛选与排序。
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouTask'
        AND INDEX_NAME = 'ChetaidouTask_ownerId_skuId_site_createdAt_id_idx') THEN
        ALTER TABLE `ChetaidouTask` ADD INDEX `ChetaidouTask_ownerId_skuId_site_createdAt_id_idx`(`ownerId`, `skuId`, `site`, `createdAt`, `id`);
    END IF;
    -- 所属历史 + 创建时间 + id：历史详情中读取该记录关联的任务。
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChetaidouTask'
        AND INDEX_NAME = 'ChetaidouTask_adjustmentId_createdAt_id_idx') THEN
        ALTER TABLE `ChetaidouTask` ADD INDEX `ChetaidouTask_adjustmentId_createdAt_id_idx`(`adjustmentId`, `createdAt`, `id`);
    END IF;
END$$
DELIMITER ;

-- 6. 执行增量变更，完成后删除临时过程，业务表和字段继续保留。
CALL `chetaidou_workflow_20261012`();
DROP PROCEDURE `chetaidou_workflow_20261012`;

-- 7. 执行后检查字段：应看到历史表的 10 个字段，以及 Draft/Task 各 3 个新增字段。
-- 查询仅展示结构，不提交业务任务或生成请求。
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
AND ((TABLE_NAME = 'ChetaidouDraft' AND COLUMN_NAME IN ('workspaceId', 'activeAdjustmentId', 'restoredFromAdjustmentId'))
 OR (TABLE_NAME = 'ChetaidouTask' AND COLUMN_NAME IN ('workspaceId', 'adjustmentId', 'site'))
 OR TABLE_NAME = 'ChetaidouAdjustment')
ORDER BY TABLE_NAME, ORDINAL_POSITION;

-- 检查四个索引的字段顺序；一个复合索引会返回多行，SEQ_IN_INDEX 表示顺序。
SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
AND INDEX_NAME IN ('ChetaidouAdjustment_ownerId_imageId_createdAt_id_idx',
 'ChetaidouAdjustment_ownerId_skuId_createdAt_id_idx',
 'ChetaidouTask_ownerId_skuId_site_createdAt_id_idx', 'ChetaidouTask_adjustmentId_createdAt_id_idx')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
