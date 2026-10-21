-- 公告管理：平台公告（软删除，生效区间 [startAt, endAt]，边界相接不算重叠）。
-- 本项目实际以 `prisma db push` 同步 dev 库（见 AGENTS.md），此文件供
-- migrate deploy 环境使用；已手工基线化的环境重放时靠 IF NOT EXISTS 跳过建表。
CREATE TABLE IF NOT EXISTS `Announcement` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `content` TEXT NOT NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `createdById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deletedAt` DATETIME(3) NULL,

    INDEX `Announcement_startAt_endAt_idx`(`startAt`, `endAt`),
    INDEX `Announcement_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Announcement` ADD CONSTRAINT `Announcement_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
