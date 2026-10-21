-- CreateTable
CREATE TABLE `SmartPricingRecord` (
    `id` VARCHAR(36) NOT NULL COMMENT '对外暴露的记录UUID',
    `userId` INTEGER NOT NULL COMMENT '所属用户ID，从JWT获取',
    `clientRequestId` VARCHAR(64) NOT NULL COMMENT '前端创建请求UUID，用于创建幂等',
    `createFingerprint` VARCHAR(64) NOT NULL COMMENT '规范化创建内容的SHA-256指纹',
    `schemaVersion` INTEGER NOT NULL DEFAULT 1 COMMENT '快照数据结构版本',
    `marketplaceCode` VARCHAR(32) NOT NULL COMMENT '唯一且稳定的站点代码，例如AMAZON_US',
    `marketplaceName` VARCHAR(64) NOT NULL COMMENT '归档时的站点展示名称，例如Amazon US',
    `currency` CHAR(3) NOT NULL COMMENT '当前固定为USD',
    `category` VARCHAR(255) NOT NULL COMMENT '商品类目展示名称',
    `productName` VARCHAR(500) NOT NULL COMMENT '列表摘要：商品名称',
    `suggestedPrice` DECIMAL(18, 6) NOT NULL COMMENT '列表摘要：建议售价',
    `netMargin` DECIMAL(12, 6) NOT NULL COMMENT '列表摘要：净利率，按百分数保存',
    `netProfit` DECIMAL(18, 6) NOT NULL COMMENT '列表摘要：单件净利',
    `floorPrice` DECIMAL(18, 6) NOT NULL COMMENT '列表摘要：保本价',
    `compositeScore` DECIMAL(7, 4) NOT NULL COMMENT '列表摘要：综合评分',
    `verdictText` VARCHAR(255) NOT NULL COMMENT '列表摘要：结论文案',
    `product` JSON NOT NULL COMMENT '完整产品输入快照',
    `inputSnapshot` JSON NOT NULL COMMENT '完整定价输入快照',
    `competitorContext` JSON NULL COMMENT '竞品上下文，竞品查询失败时为NULL',
    `result` JSON NOT NULL COMMENT '完整定价结果快照',
    `version` INTEGER NOT NULL DEFAULT 1 COMMENT '记录版本',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
    `updatedAt` DATETIME(3) NOT NULL COMMENT '最后更新时间',
    `deletedAt` DATETIME(3) NULL COMMENT '软删除时间',

    UNIQUE INDEX `SmartPricingRecord_userId_clientRequestId_key`(`userId`, `clientRequestId`),
    INDEX `SmartPricingRecord_userId_deletedAt_createdAt_idx`(`userId`, `deletedAt`, `createdAt`),
    INDEX `SmartPricingRecord_user_market_created_idx`(`userId`, `marketplaceCode`, `deletedAt`, `createdAt`),
    INDEX `SmartPricingRecord_user_category_created_idx`(`userId`, `category`, `deletedAt`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_smart_pricing_schema_version` CHECK (`schemaVersion` >= 1),
    CONSTRAINT `chk_smart_pricing_version` CHECK (`version` >= 1),
    CONSTRAINT `chk_smart_pricing_suggested_price` CHECK (`suggestedPrice` >= 0),
    CONSTRAINT `chk_smart_pricing_floor_price` CHECK (`floorPrice` >= 0),
    CONSTRAINT `chk_smart_pricing_composite_score` CHECK (`compositeScore` BETWEEN 0 AND 100)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT='用户智能定价历史快照';

ALTER TABLE `SmartPricingRecord`
  ADD CONSTRAINT `SmartPricingRecord_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
