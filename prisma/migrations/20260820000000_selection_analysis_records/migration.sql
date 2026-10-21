-- CreateTable
CREATE TABLE `SelectionAnalysisRecord` (
    `id` VARCHAR(36) NOT NULL COMMENT '分析记录ID，UUID格式',
    `userId` INTEGER NOT NULL COMMENT '所属用户ID，从JWT获取',
    `clientRequestId` VARCHAR(64) NOT NULL COMMENT '前端创建请求唯一ID，用于创建幂等',
    `createFingerprint` VARCHAR(64) NOT NULL COMMENT '创建请求规范化内容的SHA-256指纹',
    `marketplace` VARCHAR(16) NOT NULL COMMENT '电商站点代码，例如US、UK、DE、JP',
    `entry` ENUM('CATALOG', 'PRODUCT') NOT NULL DEFAULT 'CATALOG' COMMENT '分析入口：CATALOG逛类目，PRODUCT验证单品',
    `primaryCategoryNodeId` VARCHAR(255) NULL COMMENT '主类目节点ID',
    `primaryCategoryPath` VARCHAR(1000) NULL COMMENT '主类目完整路径，用于列表展示和搜索',
    `primaryCategoryName` VARCHAR(500) NULL COMMENT '主类目名称，优先保存中文名',
    `categories` JSON NOT NULL COMMENT '本次分析选择的全部类目上下文JSON',
    `lastCompletedStep` INTEGER NOT NULL DEFAULT 1 COMMENT '当前有效的最高已完成步骤，范围1到5',
    `pickCount` INTEGER NOT NULL DEFAULT 0 COMMENT '第5步最终入选商品数量，未完成时为0',
    `status` ENUM('PROCESSING', 'COMPLETED') NOT NULL DEFAULT 'PROCESSING' COMMENT '分析状态：PROCESSING进行中，COMPLETED已完成',
    `version` INTEGER NOT NULL DEFAULT 1 COMMENT '主记录乐观锁版本，每次有效步骤变更递增',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
    `updatedAt` DATETIME(3) NOT NULL COMMENT '最后更新时间',
    `deletedAt` DATETIME(3) NULL COMMENT '软删除时间，NULL表示未删除',

    -- 同一用户的同一个创建请求只能对应一条分析记录
    UNIQUE INDEX `SelectionAnalysisRecord_userId_clientRequestId_key`(`userId`, `clientRequestId`),
    -- 当前用户分析记录列表按更新时间查询
    INDEX `SelectionAnalysisRecord_userId_deletedAt_updatedAt_idx`(`userId`, `deletedAt`, `updatedAt`),
    -- 当前用户按站点筛选分析记录
    INDEX `SelectionAnalysisRecord_user_marketplace_updated_idx`(`userId`, `marketplace`, `deletedAt`, `updatedAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_selection_last_completed_step` CHECK (`lastCompletedStep` BETWEEN 1 AND 5),
    CONSTRAINT `chk_selection_pick_count` CHECK (`pickCount` >= 0),
    CONSTRAINT `chk_selection_version` CHECK (`version` >= 1)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT='选品分析主记录，一次完整分析一条';

-- CreateTable
CREATE TABLE `SelectionAnalysisStep` (
    `id` INTEGER NOT NULL AUTO_INCREMENT COMMENT '步骤记录自增主键',
    `analysisId` VARCHAR(36) NOT NULL COMMENT '所属分析记录ID',
    `stepNo` INTEGER NOT NULL COMMENT '步骤编号，范围1到5',
    `stepType` ENUM('CATEGORY_DIAGNOSIS', 'TRACK_VALIDATION', 'COMPETITOR_POOL', 'TRAFFIC_AD_VALIDATION', 'PRODUCT_LIST') NOT NULL COMMENT '步骤类型：类目诊断、赛道验证、竞品池、流量广告验证、产品清单',
    `schemaVersion` INTEGER NOT NULL DEFAULT 1 COMMENT '当前步骤payload的数据结构版本',
    `payload` JSON NOT NULL COMMENT '当前步骤完整结果JSON，不包含其他步骤数据',
    `payloadHash` VARCHAR(64) NOT NULL COMMENT '规范化payload的SHA-256哈希，用于内容幂等',
    `revision` INTEGER NOT NULL DEFAULT 1 COMMENT '当前步骤内容修订版本，实际变化时递增',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '首次保存时间',
    `updatedAt` DATETIME(3) NOT NULL COMMENT '最后更新时间',

    -- 每次分析的每个步骤只保留一条当前有效结果
    UNIQUE INDEX `SelectionAnalysisStep_analysisId_stepNo_key`(`analysisId`, `stepNo`),
    -- 按分析ID加载全部步骤
    INDEX `SelectionAnalysisStep_analysisId_idx`(`analysisId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_selection_step_no` CHECK (`stepNo` BETWEEN 1 AND 5),
    CONSTRAINT `chk_selection_schema_version` CHECK (`schemaVersion` >= 1),
    CONSTRAINT `chk_selection_revision` CHECK (`revision` >= 1)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT='选品分析分步结果，每个分析最多五条当前有效记录';

-- CreateTable
CREATE TABLE `ProductLibraryItem` (
    `id` INTEGER NOT NULL AUTO_INCREMENT COMMENT '商品库记录自增主键',
    `userId` INTEGER NOT NULL COMMENT '所属用户ID，从JWT获取',
    `marketplace` VARCHAR(16) NOT NULL COMMENT '电商站点代码，例如US、UK、DE、JP',
    `asin` VARCHAR(32) NOT NULL COMMENT 'Amazon ASIN，入库时统一转大写',
    `title` VARCHAR(1000) NULL COMMENT '商品标题',
    `brand` VARCHAR(255) NULL COMMENT '品牌名称',
    `imageUrl` VARCHAR(2048) NULL COMMENT '商品主图URL',
    `tags` JSON NULL COMMENT '用户标签字符串数组',
    `notes` TEXT NULL COMMENT '用户备注',
    `latestKeyword` VARCHAR(500) NULL COMMENT '最新一次画像的主攻关键词',
    `latestCompScore` DECIMAL(10, 4) NULL COMMENT '最新一次画像的竞品综合评分',
    `latestPrice` DECIMAL(12, 2) NULL COMMENT '最新一次画像的商品价格',
    `latestMonthlySales` INTEGER NULL COMMENT '最新一次画像的月销量',
    `latestRatingNum` INTEGER NULL COMMENT '最新一次画像的评论数量',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '首次入库时间',
    `updatedAt` DATETIME(3) NOT NULL COMMENT '最后更新时间',
    `deletedAt` DATETIME(3) NULL COMMENT '软删除时间，NULL表示未删除',

    -- 同一用户、站点和ASIN在商品库中只有一条主记录
    UNIQUE INDEX `ProductLibraryItem_userId_marketplace_asin_key`(`userId`, `marketplace`, `asin`),
    -- 当前用户商品库列表按更新时间查询
    INDEX `ProductLibraryItem_userId_deletedAt_updatedAt_idx`(`userId`, `deletedAt`, `updatedAt`),
    -- 当前用户按站点和最新评分筛选、排序
    INDEX `ProductLibraryItem_user_marketplace_score_idx`(`userId`, `marketplace`, `deletedAt`, `latestCompScore`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_product_library_latest_comp_score` CHECK (`latestCompScore` IS NULL OR `latestCompScore` >= 0),
    CONSTRAINT `chk_product_library_latest_price` CHECK (`latestPrice` IS NULL OR `latestPrice` >= 0),
    CONSTRAINT `chk_product_library_latest_monthly_sales` CHECK (`latestMonthlySales` IS NULL OR `latestMonthlySales` >= 0),
    CONSTRAINT `chk_product_library_latest_rating_num` CHECK (`latestRatingNum` IS NULL OR `latestRatingNum` >= 0)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT='用户商品库主表，同一站点的同一ASIN只保存一条';

-- CreateTable
CREATE TABLE `ProductLibrarySnapshot` (
    `id` INTEGER NOT NULL AUTO_INCREMENT COMMENT '商品画像快照自增主键',
    `itemId` INTEGER NOT NULL COMMENT '所属商品库主记录ID',
    `sourceAnalysisId` VARCHAR(36) NOT NULL COMMENT '来源选品分析记录ID',
    `keyword` VARCHAR(500) NOT NULL COMMENT '该画像对应的主攻关键词',
    `compScore` DECIMAL(10, 4) NULL COMMENT '该次分析的竞品综合评分',
    `price` DECIMAL(12, 2) NULL COMMENT '该次分析的商品价格',
    `monthlySales` INTEGER NULL COMMENT '该次分析的月销量',
    `ratingNum` INTEGER NULL COMMENT '该次分析的评论数量',
    `profile` JSON NOT NULL COMMENT '来源分析中的完整商品画像JSON快照',
    `profileHash` VARCHAR(64) NOT NULL COMMENT '画像及摘要字段的SHA-256哈希，用于入库幂等',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '画像首次入库时间',
    `updatedAt` DATETIME(3) NOT NULL COMMENT '画像最后更新时间',

    -- 同一商品、来源分析和关键词只保留一份画像
    UNIQUE INDEX `ProductLibrarySnapshot_itemId_sourceAnalysisId_keyword_key`(`itemId`, `sourceAnalysisId`, `keyword`),
    -- 按来源分析查询已入库画像
    INDEX `ProductLibrarySnapshot_sourceAnalysisId_idx`(`sourceAnalysisId`),
    -- 按商品查询画像并按更新时间排序
    INDEX `ProductLibrarySnapshot_itemId_updatedAt_idx`(`itemId`, `updatedAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_product_library_comp_score` CHECK (`compScore` IS NULL OR `compScore` >= 0),
    CONSTRAINT `chk_product_library_price` CHECK (`price` IS NULL OR `price` >= 0),
    CONSTRAINT `chk_product_library_monthly_sales` CHECK (`monthlySales` IS NULL OR `monthlySales` >= 0),
    CONSTRAINT `chk_product_library_rating_num` CHECK (`ratingNum` IS NULL OR `ratingNum` >= 0)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT='商品库来源画像快照，保留不同分析和关键词下的历史画像';

-- AddForeignKey
-- 分析记录归属用户；存在分析记录时禁止物理删除用户
ALTER TABLE `SelectionAnalysisRecord` ADD CONSTRAINT `SelectionAnalysisRecord_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- 物理删除分析主记录时级联清理步骤；软删除不会触发
ALTER TABLE `SelectionAnalysisStep` ADD CONSTRAINT `SelectionAnalysisStep_analysisId_fkey` FOREIGN KEY (`analysisId`) REFERENCES `SelectionAnalysisRecord`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- 商品库记录归属用户；存在商品记录时禁止物理删除用户
ALTER TABLE `ProductLibraryItem` ADD CONSTRAINT `ProductLibraryItem_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- 物理删除商品主记录时级联清理其画像快照；软删除不会触发
ALTER TABLE `ProductLibrarySnapshot` ADD CONSTRAINT `ProductLibrarySnapshot_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `ProductLibraryItem`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- 商品画像必须保留可追溯来源，存在画像时禁止物理删除分析记录
ALTER TABLE `ProductLibrarySnapshot` ADD CONSTRAINT `ProductLibrarySnapshot_sourceAnalysisId_fkey` FOREIGN KEY (`sourceAnalysisId`) REFERENCES `SelectionAnalysisRecord`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
