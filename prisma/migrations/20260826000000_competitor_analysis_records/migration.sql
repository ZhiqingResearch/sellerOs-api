-- CreateTable
CREATE TABLE `CompetitorAnalysisRecord` (
    `id` VARCHAR(36) NOT NULL COMMENT '对外暴露的竞品分析记录UUID',
    `userId` INTEGER NOT NULL COMMENT '所属用户ID，从JWT获取',
    `clientRequestId` VARCHAR(36) NOT NULL COMMENT '前端创建请求UUID，用于创建幂等',
    `createFingerprint` CHAR(64) NOT NULL COMMENT '规范化创建内容的SHA-256指纹',
    `schemaVersion` INTEGER NOT NULL DEFAULT 1 COMMENT '快照数据结构版本',
    `marketplace` VARCHAR(16) NOT NULL COMMENT '站点代码，例如US/UK/DE/JP/MX',
    `mode` ENUM('ASIN', 'KEYWORD') NOT NULL COMMENT '分析输入模式',
    `ownAsin` CHAR(10) NULL COMMENT '我方ASIN，未提供时为NULL',
    `competitorAsins` JSON NOT NULL COMMENT '规范化后的竞品ASIN列表摘要',
    `sourceKeyword` VARCHAR(500) NULL COMMENT '关键词模式的来源关键词',
    `title` VARCHAR(500) NOT NULL COMMENT '列表标题，由后端生成',
    `productCount` INTEGER NOT NULL COMMENT '本次保存的产品数量',
    `competitorCount` INTEGER NOT NULL COMMENT '输入中的竞品ASIN数量',
    `inputSnapshot` JSON NOT NULL COMMENT '完整分析输入快照',
    `analysisResult` JSON NOT NULL COMMENT '总体分析结果快照',
    `reportData` JSON NOT NULL COMMENT '最终竞品分析报告快照',
    `reportPdfUrl` VARCHAR(2048) NULL COMMENT '前端生成并上传OSS后的PDF URL',
    `reportPdfUpdatedAt` DATETIME(3) NULL COMMENT 'PDF URL最近更新时间',
    `payloadBytes` INTEGER NOT NULL COMMENT '主表、产品和步骤全部JSON的UTF-8总字节数',
    `version` INTEGER NOT NULL DEFAULT 1 COMMENT '记录版本，PDF回写或软删除时递增',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `CompetitorAnalysisRecord_userId_clientRequestId_key`(`userId`, `clientRequestId`),
    INDEX `CompetitorAnalysisRecord_userId_deletedAt_createdAt_idx`(`userId`, `deletedAt`, `createdAt`),
    INDEX `CompetitorAnalysisRecord_user_market_created_idx`(`userId`, `marketplace`, `deletedAt`, `createdAt`),
    INDEX `CompetitorAnalysisRecord_user_own_asin_created_idx`(`userId`, `ownAsin`, `deletedAt`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_competitor_analysis_schema_version` CHECK (`schemaVersion` >= 1),
    CONSTRAINT `chk_competitor_analysis_product_count` CHECK (`productCount` >= 1),
    CONSTRAINT `chk_competitor_analysis_competitor_count` CHECK (`competitorCount` >= 1),
    CONSTRAINT `chk_competitor_analysis_payload_bytes` CHECK (`payloadBytes` >= 0),
    CONSTRAINT `chk_competitor_analysis_version` CHECK (`version` >= 1)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT='用户竞品分析历史主记录';

-- CreateTable
CREATE TABLE `CompetitorAnalysisProduct` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `recordId` VARCHAR(36) NOT NULL,
    `asin` CHAR(10) NOT NULL COMMENT '产品ASIN，用于唯一定位和历史搜索',
    `sortOrder` INTEGER NOT NULL COMMENT '产品展示顺序',
    `productData` JSON NOT NULL COMMENT '前端传入的完整产品信息',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CompetitorAnalysisProduct_recordId_asin_key`(`recordId`, `asin`),
    UNIQUE INDEX `CompetitorAnalysisProduct_recordId_sortOrder_key`(`recordId`, `sortOrder`),
    INDEX `CompetitorAnalysisProduct_asin_record_idx`(`asin`, `recordId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_competitor_analysis_product_sort_order` CHECK (`sortOrder` >= 0)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT='竞品分析记录中的产品快照';

-- CreateTable
CREATE TABLE `CompetitorAnalysisProductStep` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `productId` INTEGER NOT NULL,
    `stepCode` VARCHAR(64) NOT NULL COMMENT '前端提供的稳定步骤代码',
    `stepNo` INTEGER NOT NULL COMMENT '产品内步骤展示顺序',
    `schemaVersion` INTEGER NOT NULL DEFAULT 1 COMMENT '步骤结果结构版本',
    `resultData` JSON NOT NULL COMMENT '前端传入的步骤分析结果',
    `payloadHash` CHAR(64) NOT NULL COMMENT '规范化步骤内容的SHA-256',
    `payloadBytes` INTEGER NOT NULL COMMENT '步骤结果UTF-8 JSON字节数',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CompetitorAnalysisProductStep_productId_stepCode_key`(`productId`, `stepCode`),
    UNIQUE INDEX `CompetitorAnalysisProductStep_productId_stepNo_key`(`productId`, `stepNo`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_competitor_analysis_step_no` CHECK (`stepNo` >= 0),
    CONSTRAINT `chk_competitor_analysis_step_schema_version` CHECK (`schemaVersion` >= 1),
    CONSTRAINT `chk_competitor_analysis_step_payload_bytes` CHECK (`payloadBytes` >= 0)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT='竞品分析产品的步骤结果快照';

-- AddForeignKey
ALTER TABLE `CompetitorAnalysisRecord`
  ADD CONSTRAINT `CompetitorAnalysisRecord_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CompetitorAnalysisProduct`
  ADD CONSTRAINT `CompetitorAnalysisProduct_recordId_fkey`
  FOREIGN KEY (`recordId`) REFERENCES `CompetitorAnalysisRecord`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CompetitorAnalysisProductStep`
  ADD CONSTRAINT `CompetitorAnalysisProductStep_productId_fkey`
  FOREIGN KEY (`productId`) REFERENCES `CompetitorAnalysisProduct`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
