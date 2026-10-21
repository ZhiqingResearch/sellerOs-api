-- AlterTable
ALTER TABLE `ProductPublishStoreClassification`
    ADD COLUMN `templateRequestId` VARCHAR(100) NULL;

-- AlterTable
ALTER TABLE `ProductPublishTask`
    ADD COLUMN `resultRequestId` VARCHAR(100) NULL,
    ADD COLUMN `submitCorrelationKey` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `ProductPublishRpaLog`
    ADD COLUMN `status` ENUM('DISPATCHING', 'WAITING_CALLBACK', 'PROCESSING_CALLBACK', 'SUCCESS', 'FAILED', 'TIMEOUT') NOT NULL DEFAULT 'DISPATCHING',
    ADD COLUMN `dispatchResponsePayload` JSON NULL,
    ADD COLUMN `dispatchedAt` DATETIME(3) NULL,
    ADD COLUMN `callbackReceivedAt` DATETIME(3) NULL,
    ADD COLUMN `expiresAt` DATETIME(3) NULL,
    ADD COLUMN `dispatchDurationMs` INTEGER NULL;

-- Existing rows were written by the pre-callback implementation. Preserve their
-- original terminal meaning instead of leaving them in the new DISPATCHING state.
UPDATE `ProductPublishRpaLog`
SET
    `status` = CASE WHEN `success` = TRUE THEN 'SUCCESS' ELSE 'FAILED' END,
    `dispatchResponsePayload` = `responsePayload`,
    `dispatchedAt` = `createdAt`,
    `dispatchDurationMs` = `durationMs`;

-- Replace the non-unique requestId index created by the previous migration.
DROP INDEX `ProductPublishRpaLog_requestId_idx` ON `ProductPublishRpaLog`;

-- CreateIndex
CREATE UNIQUE INDEX `ProductPublishRpaLog_requestId_key` ON `ProductPublishRpaLog`(`requestId`);

-- CreateIndex
CREATE UNIQUE INDEX `ProductPublishTask_resultRequestId_key` ON `ProductPublishTask`(`resultRequestId`);

-- CreateIndex
CREATE UNIQUE INDEX `ProductPublishTask_submitCorrelationKey_key` ON `ProductPublishTask`(`submitCorrelationKey`);

-- CreateIndex
CREATE UNIQUE INDEX `ProductPublishStoreClassification_templateRequestId_key` ON `ProductPublishStoreClassification`(`templateRequestId`);

-- CreateIndex
CREATE INDEX `ProductPublishRpaLog_status_expiresAt_idx` ON `ProductPublishRpaLog`(`status`, `expiresAt`);
