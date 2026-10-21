-- Public charge v2 tables/columns were added to Prisma schema before a repository migration
-- was committed. Keep these statements idempotent so environments that were manually
-- baselined can still deploy this migration.
CREATE TABLE IF NOT EXISTS `AiGatewayModel` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `publicId` VARCHAR(100) NOT NULL,
    `category` VARCHAR(50) NOT NULL,
    `displayName` VARCHAR(200) NOT NULL,
    `modality` ENUM('TEXT', 'IMAGE', 'VIDEO') NOT NULL,
    `execMode` ENUM('SYNC', 'ASYNC') NOT NULL,
    `gatewayConfig` JSON NOT NULL,
    `quoteConfig` JSON NULL,
    `gatewayActive` BOOLEAN NOT NULL DEFAULT false,
    `syncedAt` DATETIME(3) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AiGatewayModel_publicId_category_key`(`publicId`, `category`),
    INDEX `AiGatewayModel_modality_category_enabled_gatewayActive_idx`(`modality`, `category`, `enabled`, `gatewayActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `FeatureModule` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `source` VARCHAR(50) NOT NULL,
    `label` VARCHAR(50) NOT NULL,
    `module` VARCHAR(30) NULL,
    `moduleLabel` VARCHAR(50) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `FeatureModule_source_key`(`source`),
    INDEX `FeatureModule_module_active_idx`(`module`, `active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @usage_request_id_exists = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'UsageLog'
      AND COLUMN_NAME = 'requestId'
);
SET @usage_request_id_sql = IF(
    @usage_request_id_exists = 0,
    'ALTER TABLE `UsageLog` ADD COLUMN `requestId` VARCHAR(64) NULL',
    'SELECT 1'
);
PREPARE usage_request_id_stmt FROM @usage_request_id_sql;
EXECUTE usage_request_id_stmt;
DEALLOCATE PREPARE usage_request_id_stmt;

SET @usage_request_id_index_exists = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'UsageLog'
      AND INDEX_NAME = 'UsageLog_requestId_key'
);
SET @usage_request_id_index_sql = IF(
    @usage_request_id_index_exists = 0,
    'CREATE UNIQUE INDEX `UsageLog_requestId_key` ON `UsageLog`(`requestId`)',
    'SELECT 1'
);
PREPARE usage_request_id_index_stmt FROM @usage_request_id_index_sql;
EXECUTE usage_request_id_index_stmt;
DEALLOCATE PREPARE usage_request_id_index_stmt;

-- AI split task data.
ALTER TABLE `ProductImage`
    ADD COLUMN `purpose` VARCHAR(30) NULL;

ALTER TABLE `GenerationTask`
    MODIFY `model` VARCHAR(100) NOT NULL,
    ADD COLUMN `generationMode` VARCHAR(30) NOT NULL DEFAULT 'STANDARD',
    ADD COLUMN `groupId` VARCHAR(64) NULL,
    ADD COLUMN `clientRequestId` VARCHAR(64) NULL,
    ADD COLUMN `directionIndex` INTEGER NULL,
    ADD COLUMN `aiSplitStage` VARCHAR(32) NULL,
    ADD COLUMN `retryOfTaskId` INTEGER NULL;

CREATE UNIQUE INDEX `GenerationTask_userId_clientRequestId_directionIndex_key`
    ON `GenerationTask`(`userId`, `clientRequestId`, `directionIndex`);
CREATE INDEX `GenerationTask_userId_generationMode_groupId_idx`
    ON `GenerationTask`(`userId`, `generationMode`, `groupId`);
CREATE INDEX `GenerationTask_generationMode_aiSplitStage_updatedAt_idx`
    ON `GenerationTask`(`generationMode`, `aiSplitStage`, `updatedAt`);
CREATE INDEX `GenerationTask_retryOfTaskId_idx`
    ON `GenerationTask`(`retryOfTaskId`);

ALTER TABLE `GenerationTask`
    ADD CONSTRAINT `GenerationTask_retryOfTaskId_fkey`
    FOREIGN KEY (`retryOfTaskId`) REFERENCES `GenerationTask`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AI split template snapshots used by "save as template" and later SKU reuse.
ALTER TABLE `ImageTemplateItem`
    ADD COLUMN `competitorTemplate` JSON NULL,
    ADD COLUMN `generationSettings` JSON NULL,
    ADD COLUMN `site` VARCHAR(30) NULL,
    ADD COLUMN `promptVersion` VARCHAR(20) NULL,
    ADD COLUMN `promptHash` CHAR(64) NULL;
