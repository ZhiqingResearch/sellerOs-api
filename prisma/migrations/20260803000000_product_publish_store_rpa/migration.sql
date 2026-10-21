-- Compatibility bootstrap
-- ProductPublishTask was previously managed through schema sync without a committed migration.
-- Fresh databases need the pre-upgrade table before the ALTER below; existing databases no-op here.
CREATE TABLE IF NOT EXISTS `ProductPublishTask` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `taskId` VARCHAR(36) NOT NULL,
    `userId` INTEGER NOT NULL,
    `imageProjectId` INTEGER NULL,
    `productName` VARCHAR(200) NULL,
    `brand` VARCHAR(200) NULL,
    `classification` VARCHAR(100) NULL,
    `category` VARCHAR(500) NULL,
    `data` JSON NULL,
    `status` ENUM('DRAFT', 'COMPLETED') NOT NULL DEFAULT 'DRAFT',
    `store` VARCHAR(50) NULL,
    `type` ENUM('SINGLE', 'VARIANT') NULL,
    `productImages` JSON NULL,
    `progress` INTEGER NOT NULL DEFAULT 0,
    `spreadsheetUrl` VARCHAR(1000) NULL,
    `spreadsheetKey` VARCHAR(1000) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `ProductPublishTask_taskId_key`(`taskId`),
    UNIQUE INDEX `ProductPublishTask_imageProjectId_key`(`imageProjectId`),
    INDEX `ProductPublishTask_userId_status_updatedAt_idx`(`userId`, `status`, `updatedAt`),
    INDEX `ProductPublishTask_userId_store_idx`(`userId`, `store`),
    INDEX `ProductPublishTask_userId_classification_idx`(`userId`, `classification`),
    INDEX `ProductPublishTask_userId_type_idx`(`userId`, `type`),
    INDEX `ProductPublishTask_userId_deletedAt_idx`(`userId`, `deletedAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `ProductPublishTask_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `ProductPublishTask_imageProjectId_fkey` FOREIGN KEY (`imageProjectId`) REFERENCES `ImageProject`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `ProductPublishTask`
    MODIFY `status` ENUM('DRAFT', 'COMPLETED', 'PUBLISHING') NOT NULL DEFAULT 'DRAFT',
    MODIFY `store` VARCHAR(200) NULL,
    ADD COLUMN `publishStoreId` INTEGER NULL,
    ADD COLUMN `uploadId` VARCHAR(100) NULL,
    ADD COLUMN `rpaTaskUuid` VARCHAR(100) NULL,
    ADD COLUMN `rpaJobUuidList` JSON NULL,
    ADD COLUMN `submitRequestId` VARCHAR(100) NULL,
    ADD COLUMN `successCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `failedCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `submittedFileUrl` VARCHAR(1000) NULL,
    ADD COLUMN `resultFileUrl` VARCHAR(1000) NULL,
    ADD COLUMN `skuAsinMapping` JSON NULL,
    ADD COLUMN `publishOutcome` ENUM('SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'TIMEOUT') NULL,
    ADD COLUMN `publishSubmittedAt` DATETIME(3) NULL,
    ADD COLUMN `publishCompletedAt` DATETIME(3) NULL,
    ADD COLUMN `lastPolledAt` DATETIME(3) NULL,
    ADD COLUMN `nextPollAt` DATETIME(3) NULL,
    ADD COLUMN `pollAttempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `publishErrorMessage` TEXT NULL;

-- CreateTable
CREATE TABLE `ProductPublishStore` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `externalStoreId` VARCHAR(32) NOT NULL,
    `feishuRecordId` VARCHAR(100) NOT NULL,
    `sourceUuid` VARCHAR(100) NULL,
    `name` VARCHAR(200) NOT NULL,
    `shortName` VARCHAR(100) NULL,
    `companyName` VARCHAR(200) NULL,
    `platform` VARCHAR(50) NOT NULL DEFAULT 'AMAZON',
    `storeType` VARCHAR(50) NULL,
    `accountType` VARCHAR(50) NULL,
    `childStore` VARCHAR(200) NULL,
    `site` VARCHAR(50) NULL,
    `remark` TEXT NULL,
    `disabled` BOOLEAN NOT NULL DEFAULT false,
    `sourceUpdatedAt` DATETIME(3) NULL,
    `lastSyncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProductPublishStore_externalStoreId_key`(`externalStoreId`),
    INDEX `ProductPublishStore_feishuRecordId_idx`(`feishuRecordId`),
    INDEX `ProductPublishStore_disabled_platform_idx`(`disabled`, `platform`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductPublishClassificationCatalog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(100) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProductPublishClassificationCatalog_code_key`(`code`),
    INDEX `ProductPublishClassificationCatalog_active_sortOrder_idx`(`active`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- SeedData
INSERT INTO `ProductPublishClassificationCatalog`
    (`code`, `name`, `sortOrder`, `active`, `createdAt`, `updatedAt`)
VALUES
    ('NOTEBOOK_COMPUTER', 'laptop', 0, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('TABLET_COMPUTER', 'Tablet Computer', 1, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('ELECTRONIC_DEVICE_DOCKING_STATION', 'Electronic Device Docking Station', 2, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('WEARABLE_COMPUTER', 'Wearable Computer', 3, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('SPEAKERS', 'Speaker', 4, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('KEYBOARD_MOUSE_SET', 'Keyboard & Mouse Set', 5, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('KEYBOARDS', 'Keyboard', 6, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('PERSONAL_COMPUTER', 'Desktop', 7, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('MULTIPORT_HUB', 'Multiport Hub', 8, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('CAMCORDER', 'Camcorder', 9, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('HEADPHONES', 'Headphones', 10, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('CONSOLE_VIDEO_GAMES', 'CONSOLE_VIDEO_GAMES', 11, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE
    `name` = VALUES(`name`),
    `sortOrder` = VALUES(`sortOrder`),
    `active` = VALUES(`active`),
    `updatedAt` = CURRENT_TIMESTAMP(3);

-- CreateTable
CREATE TABLE `ProductPublishFeishuSyncRun` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `trigger` ENUM('SCHEDULED', 'MANUAL') NOT NULL,
    `status` ENUM('RUNNING', 'SUCCESS', 'PARTIAL_FAILED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'RUNNING',
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `durationMs` INTEGER NULL,
    `totalCount` INTEGER NOT NULL DEFAULT 0,
    `successCount` INTEGER NOT NULL DEFAULT 0,
    `failedCount` INTEGER NOT NULL DEFAULT 0,
    `skippedCount` INTEGER NOT NULL DEFAULT 0,
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ProductPublishFeishuSyncRun_status_startedAt_idx`(`status`, `startedAt`),
    INDEX `ProductPublishFeishuSyncRun_trigger_startedAt_idx`(`trigger`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductPublishFeishuSyncRecord` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `runId` INTEGER NOT NULL,
    `feishuRecordId` VARCHAR(100) NULL,
    `externalStoreId` VARCHAR(32) NULL,
    `status` ENUM('SUCCESS', 'SKIPPED', 'FAILED') NOT NULL,
    `action` ENUM('CREATED', 'UPDATED', 'SKIPPED') NULL,
    `message` TEXT NULL,
    `durationMs` INTEGER NULL,
    `sourceUpdatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ProductPublishFeishuSyncRecord_runId_status_idx`(`runId`, `status`),
    INDEX `ProductPublishFeishuSyncRecord_feishuRecordId_createdAt_idx`(`feishuRecordId`, `createdAt`),
    INDEX `ProductPublishFeishuSyncRecord_externalStoreId_createdAt_idx`(`externalStoreId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductPublishStoreClassification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `storeId` INTEGER NOT NULL,
    `classification` VARCHAR(100) NOT NULL,
    `classificationName` VARCHAR(100) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `templateUrl` VARCHAR(1000) NULL,
    `templateStatus` ENUM('PENDING', 'SUCCESS', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `templateSyncedAt` DATETIME(3) NULL,
    `lastSyncError` TEXT NULL,
    `rpaTaskUuid` VARCHAR(100) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProductPublishStoreClassification_storeId_classification_key`(`storeId`, `classification`),
    INDEX `ProductPublishStoreClassification_storeId_sortOrder_idx`(`storeId`, `sortOrder`),
    INDEX `PPSC_templateStatus_syncedAt_idx`(`templateStatus`, `templateSyncedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductPublishRpaRun` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `operation` ENUM('FETCH_TEMPLATE', 'SUBMIT_PUBLISH', 'QUERY_RESULT') NOT NULL,
    `status` ENUM('RUNNING', 'SUCCESS', 'PARTIAL_FAILED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'RUNNING',
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `durationMs` INTEGER NULL,
    `totalCount` INTEGER NOT NULL DEFAULT 0,
    `successCount` INTEGER NOT NULL DEFAULT 0,
    `failedCount` INTEGER NOT NULL DEFAULT 0,
    `skippedCount` INTEGER NOT NULL DEFAULT 0,
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ProductPublishRpaRun_operation_startedAt_idx`(`operation`, `startedAt`),
    INDEX `ProductPublishRpaRun_status_startedAt_idx`(`status`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductPublishRpaLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `operation` ENUM('FETCH_TEMPLATE', 'SUBMIT_PUBLISH', 'QUERY_RESULT') NOT NULL,
    `source` ENUM('API', 'CRON') NOT NULL,
    `runId` INTEGER NULL,
    `taskId` INTEGER NULL,
    `storeId` INTEGER NULL,
    `classification` VARCHAR(100) NULL,
    `requestId` VARCHAR(100) NULL,
    `idempotentUuid` VARCHAR(100) NULL,
    `rpaTaskUuid` VARCHAR(100) NULL,
    `rpaJobUuidList` JSON NULL,
    `uploadId` VARCHAR(100) NULL,
    `requestPayload` JSON NULL,
    `responsePayload` JSON NULL,
    `httpStatus` INTEGER NULL,
    `success` BOOLEAN NOT NULL DEFAULT false,
    `durationMs` INTEGER NOT NULL DEFAULT 0,
    `attempt` INTEGER NOT NULL DEFAULT 1,
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ProductPublishRpaLog_taskId_createdAt_idx`(`taskId`, `createdAt`),
    INDEX `ProductPublishRpaLog_runId_createdAt_idx`(`runId`, `createdAt`),
    INDEX `ProductPublishRpaLog_storeId_operation_createdAt_idx`(`storeId`, `operation`, `createdAt`),
    INDEX `ProductPublishRpaLog_operation_success_createdAt_idx`(`operation`, `success`, `createdAt`),
    INDEX `ProductPublishRpaLog_uploadId_idx`(`uploadId`),
    INDEX `ProductPublishRpaLog_requestId_idx`(`requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `ProductPublishTask_submitRequestId_key` ON `ProductPublishTask`(`submitRequestId`);

-- CreateIndex
CREATE INDEX `ProductPublishTask_status_nextPollAt_idx` ON `ProductPublishTask`(`status`, `nextPollAt`);

-- CreateIndex
CREATE INDEX `ProductPublishTask_publishStoreId_status_createdAt_idx` ON `ProductPublishTask`(`publishStoreId`, `status`, `createdAt`);

-- CreateIndex
CREATE UNIQUE INDEX `ProductPublishTask_uploadId_key` ON `ProductPublishTask`(`uploadId`);

-- AddForeignKey
ALTER TABLE `ProductPublishStoreClassification` ADD CONSTRAINT `ProductPublishStoreClassification_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `ProductPublishStore`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductPublishTask` ADD CONSTRAINT `ProductPublishTask_publishStoreId_fkey` FOREIGN KEY (`publishStoreId`) REFERENCES `ProductPublishStore`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductPublishRpaLog` ADD CONSTRAINT `ProductPublishRpaLog_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `ProductPublishRpaRun`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductPublishRpaLog` ADD CONSTRAINT `ProductPublishRpaLog_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `ProductPublishTask`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductPublishRpaLog` ADD CONSTRAINT `ProductPublishRpaLog_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `ProductPublishStore`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductPublishFeishuSyncRecord` ADD CONSTRAINT `ProductPublishFeishuSyncRecord_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `ProductPublishFeishuSyncRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
