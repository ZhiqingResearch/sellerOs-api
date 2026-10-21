-- AlterTable：品牌基因新增「生成时应用品牌色」开关 + 品牌图片 URL（取色源，独立于 LOGO）
ALTER TABLE `BrandIdentity`
    ADD COLUMN `applyBrandColor` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `brandImageUrl` VARCHAR(1000) NULL;

-- CreateTable：品牌库（品牌基因跨项目复用，userId 维度，允许同名，软删）
CREATE TABLE `BrandKit` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `brandNameZh` VARCHAR(200) NULL,
    `brandNameEn` VARCHAR(200) NULL,
    `primaryColors` JSON NULL,
    `applyBrandColor` BOOLEAN NOT NULL DEFAULT false,
    `designStyles` JSON NULL,
    `patterns` JSON NULL,
    `font` VARCHAR(50) NULL,
    `logoUrl` VARCHAR(1000) NULL,
    `brandImageUrl` VARCHAR(1000) NULL,
    `tone` VARCHAR(50) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `BrandKit_userId_deletedAt_idx`(`userId`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BrandKit` ADD CONSTRAINT `BrandKit_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
