-- 创建 ASIN 审计主表
CREATE TABLE `AsinAuditRecord` (
    `id` VARCHAR(36) NOT NULL COMMENT '对外暴露的审计记录UUID',
    `userId` INTEGER NOT NULL COMMENT '所属用户ID，从JWT获取',
    `clientRequestId` VARCHAR(36) NOT NULL COMMENT '前端创建请求UUID，用于创建幂等',
    `createFingerprint` CHAR(64) NOT NULL COMMENT '规范化创建内容的SHA-256指纹',
    `asin` CHAR(10) NOT NULL COMMENT 'Amazon ASIN，统一转大写',
    `marketplace` VARCHAR(16) NOT NULL COMMENT '电商站点代码，例如US、UK、DE',
    `country` VARCHAR(16) NOT NULL COMMENT '国家或地区代码',
    `productTitle` VARCHAR(1000) NOT NULL COMMENT '商品标题',
    `categoryNodeId` VARCHAR(255) NOT NULL COMMENT '类目节点ID',
    `categoryName` VARCHAR(500) NOT NULL COMMENT '类目名称',
    `categoryPath` VARCHAR(1000) NOT NULL COMMENT '类目完整路径',
    `adIncluded` BOOLEAN NOT NULL COMMENT '是否包含广告数据',
    `overallScore` DOUBLE NOT NULL COMMENT '综合分',
    `grade` VARCHAR(16) NOT NULL COMMENT '评分等级',
    `contentScore` DOUBLE NOT NULL COMMENT 'Listing内容分',
    `trafficScore` DOUBLE NOT NULL COMMENT '关键词与流量分',
    `adScore` DOUBLE NULL COMMENT '广告投放分，未上传广告数据时为NULL',
    `status` ENUM('SCORED', 'OPTIMIZED') NOT NULL DEFAULT 'SCORED' COMMENT '审计记录状态',
    `version` INTEGER NOT NULL DEFAULT 1 COMMENT '主记录乐观锁版本',
    `latestOptimizationRevision` INTEGER NOT NULL DEFAULT 0 COMMENT '最新优化版本，0表示尚未优化',
    `optimizedAt` DATETIME(3) NULL COMMENT '最近一次优化时间',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
    `updatedAt` DATETIME(3) NOT NULL COMMENT '最后更新时间',
    `deletedAt` DATETIME(3) NULL COMMENT '软删除时间',

    UNIQUE INDEX `AsinAuditRecord_userId_clientRequestId_key`(`userId`, `clientRequestId`),
    INDEX `AsinAuditRecord_userId_deletedAt_createdAt_idx`(`userId`, `deletedAt`, `createdAt`),
    INDEX `AsinAuditRecord_user_marketplace_created_idx`(`userId`, `marketplace`, `deletedAt`, `createdAt`),
    INDEX `AsinAuditRecord_user_asin_created_idx`(`userId`, `asin`, `deletedAt`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_asin_audit_overall_score` CHECK (`overallScore` BETWEEN 0 AND 100),
    CONSTRAINT `chk_asin_audit_content_score` CHECK (`contentScore` BETWEEN 0 AND 100),
    CONSTRAINT `chk_asin_audit_traffic_score` CHECK (`trafficScore` BETWEEN 0 AND 100),
    CONSTRAINT `chk_asin_audit_ad_score` CHECK ((`adIncluded` = 0 AND `adScore` IS NULL) OR (`adIncluded` = 1 AND `adScore` BETWEEN 0 AND 100)),
    CONSTRAINT `chk_asin_audit_version` CHECK (`version` >= 1),
    CONSTRAINT `chk_asin_audit_latest_optimization_revision` CHECK (`latestOptimizationRevision` >= 0)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT='用户ASIN审计主记录，只保存列表及检索摘要';

-- 创建第一步取证与评分固定快照表
CREATE TABLE `AsinAuditScoreSnapshot` (
    `recordId` VARCHAR(36) NOT NULL COMMENT '所属审计记录ID，同时作为主键保证一对一',
    `schemaVersion` INTEGER NOT NULL COMMENT '第一步数据结构版本',
    `evidence` JSON NOT NULL COMMENT 'A/P/B/C/D/E六卡证据及meta',
    `scoreResult` JSON NOT NULL COMMENT '完整十维评分、criteria、问题及建议',
    `payloadHash` CHAR(64) NOT NULL COMMENT '规范化快照内容的SHA-256',
    `payloadBytes` INTEGER NOT NULL COMMENT '快照UTF-8 JSON字节数',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '快照创建时间',

    PRIMARY KEY (`recordId`),
    CONSTRAINT `chk_asin_audit_score_schema_version` CHECK (`schemaVersion` >= 1),
    CONSTRAINT `chk_asin_audit_score_payload_bytes` CHECK (`payloadBytes` >= 0)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT='ASIN审计第一步取证与评分固定快照';

-- 创建历次 AI 优化结果表
CREATE TABLE `AsinAuditOptimizationRevision` (
    `id` INTEGER NOT NULL AUTO_INCREMENT COMMENT '优化版本内部自增主键',
    `recordId` VARCHAR(36) NOT NULL COMMENT '所属审计记录ID',
    `revision` INTEGER NOT NULL COMMENT '当前审计记录内从1开始递增的优化版本',
    `schemaVersion` INTEGER NOT NULL COMMENT '优化结果数据结构版本',
    `optimizationResult` JSON NOT NULL COMMENT '完整AI优化结果',
    `payloadHash` CHAR(64) NOT NULL COMMENT '规范化优化内容的SHA-256',
    `payloadBytes` INTEGER NOT NULL COMMENT '优化结果UTF-8 JSON字节数',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '优化版本创建时间',

    UNIQUE INDEX `AsinAuditOptimizationRevision_recordId_revision_key`(`recordId`, `revision`),
    INDEX `AsinAuditOptimizationRevision_recordId_createdAt_idx`(`recordId`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_asin_audit_optimization_revision` CHECK (`revision` >= 1),
    CONSTRAINT `chk_asin_audit_optimization_schema_version` CHECK (`schemaVersion` >= 1),
    CONSTRAINT `chk_asin_audit_optimization_payload_bytes` CHECK (`payloadBytes` >= 0)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT='ASIN审计历次AI优化结果';

-- 审计主记录归属用户；存在审计记录时禁止物理删除用户
ALTER TABLE `AsinAuditRecord` ADD CONSTRAINT `AsinAuditRecord_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 物理删除审计主记录时级联清理第一步快照；软删除不会触发
ALTER TABLE `AsinAuditScoreSnapshot` ADD CONSTRAINT `AsinAuditScoreSnapshot_recordId_fkey` FOREIGN KEY (`recordId`) REFERENCES `AsinAuditRecord`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- 物理删除审计主记录时级联清理优化版本；软删除不会触发
ALTER TABLE `AsinAuditOptimizationRevision` ADD CONSTRAINT `AsinAuditOptimizationRevision_recordId_fkey` FOREIGN KEY (`recordId`) REFERENCES `AsinAuditRecord`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
