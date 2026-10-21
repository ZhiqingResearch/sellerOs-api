-- Skill 市场：技能主表 / 用户下载关系 / 下载事件（幂等）。
-- 本项目实际以 `prisma db push` 同步 dev 库（见 AGENTS.md），此文件供
-- migrate deploy 环境使用；已手工基线化的环境重放时靠 IF NOT EXISTS 跳过建表。
CREATE TABLE IF NOT EXISTS `SkillMarketSkill` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `skillId` VARCHAR(64) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `category` VARCHAR(50) NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `fileUrl` VARCHAR(500) NULL,
    `downloadCount` BIGINT NOT NULL DEFAULT 0,
    `downloadEventCount` BIGINT NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SkillMarketSkill_skillId_key`(`skillId`),
    INDEX `SkillMarketSkill_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `SkillMarketUserSkill` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `skillId` VARCHAR(64) NOT NULL,
    `firstDownloadedAt` DATETIME(3) NOT NULL,
    `lastDownloadedAt` DATETIME(3) NOT NULL,
    `downloadTimes` INTEGER NOT NULL DEFAULT 1,
    `removedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SkillMarketUserSkill_skillId_removedAt_idx`(`skillId`, `removedAt`),
    UNIQUE INDEX `SkillMarketUserSkill_userId_skillId_key`(`userId`, `skillId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `SkillMarketDownloadEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `clientRequestId` VARCHAR(36) NOT NULL,
    `userId` INTEGER NOT NULL,
    `skillId` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ipHash` VARCHAR(64) NULL,
    `userAgent` VARCHAR(255) NULL,

    UNIQUE INDEX `SkillMarketDownloadEvent_clientRequestId_key`(`clientRequestId`),
    INDEX `SkillMarketDownloadEvent_skillId_createdAt_idx`(`skillId`, `createdAt`),
    INDEX `SkillMarketDownloadEvent_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SkillMarketUserSkill` ADD CONSTRAINT `SkillMarketUserSkill_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
