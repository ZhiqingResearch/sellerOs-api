-- AlterTable
ALTER TABLE `User` ADD COLUMN `balance` DECIMAL(12, 4) NOT NULL DEFAULT 720,
    ADD COLUMN `totalSpent` DECIMAL(12, 4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `PricingConfig` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(100) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `category` ENUM('TOKEN_INPUT', 'TOKEN_OUTPUT', 'MCP') NOT NULL,
    `tier` ENUM('LOW', 'HIGH', 'SINGLE') NOT NULL,
    `threshold` INTEGER NULL,
    `originalPriceUsd` DECIMAL(12, 6) NOT NULL,
    `markupPriceUsd` DECIMAL(12, 6) NOT NULL,
    `markupPriceCny` DECIMAL(12, 6) NOT NULL,
    `unit` VARCHAR(20) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `description` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PricingConfig_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UsageLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `type` ENUM('TOKEN', 'MCP') NOT NULL,
    `promptTokens` INTEGER NULL,
    `completionTokens` INTEGER NULL,
    `thinkingTokens` INTEGER NULL,
    `mcpCalls` INTEGER NULL,
    `inputCost` DECIMAL(12, 6) NULL,
    `outputCost` DECIMAL(12, 6) NULL,
    `cost` DECIMAL(12, 6) NOT NULL,
    `balanceAfter` DECIMAL(12, 4) NOT NULL,
    `source` VARCHAR(100) NULL,
    `meta` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `UsageLog_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `UsageLog_userId_type_idx`(`userId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `UsageLog` ADD CONSTRAINT `UsageLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
