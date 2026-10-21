-- CreateTable
CREATE TABLE `ImageProject` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(200) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'DRAFT',
    `userId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `ImageProject_userId_deletedAt_idx`(`userId`, `deletedAt`),
    INDEX `ImageProject_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductProfile` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `projectId` INTEGER NOT NULL,
    `productName` VARCHAR(200) NULL,
    `sku` VARCHAR(100) NULL,
    `brandName` VARCHAR(200) NULL,
    `categoryL1` VARCHAR(100) NULL,
    `categoryL2` VARCHAR(100) NULL,
    `categoryL3` VARCHAR(100) NULL,
    `attributes` JSON NULL,
    `sellingPoints` JSON NULL,
    `certifications` JSON NULL,
    `audience` JSON NULL,
    `extra` TEXT NULL,
    `manualPdfUrl` VARCHAR(1000) NULL,
    `sourceUrl` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `ProductProfile_projectId_key`(`projectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BrandIdentity` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `projectId` INTEGER NOT NULL,
    `brandNameZh` VARCHAR(200) NULL,
    `brandNameEn` VARCHAR(200) NULL,
    `primaryColorHex` VARCHAR(10) NULL,
    `designStyle` VARCHAR(50) NULL,
    `pattern` VARCHAR(50) NULL,
    `font` VARCHAR(50) NULL,
    `logoUrl` VARCHAR(1000) NULL,
    `tone` VARCHAR(50) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `BrandIdentity_projectId_key`(`projectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductImage` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `projectId` INTEGER NOT NULL,
    `url` VARCHAR(1000) NOT NULL,
    `tag` VARCHAR(50) NULL,
    `note` VARCHAR(500) NULL,
    `isPrimary` BOOLEAN NOT NULL DEFAULT false,
    `order` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `ProductImage_projectId_deletedAt_idx`(`projectId`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GenerationTask` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `projectId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `presetCategory` VARCHAR(50) NOT NULL,
    `presetOption` VARCHAR(100) NULL,
    `model` VARCHAR(50) NOT NULL,
    `prompt` TEXT NOT NULL,
    `textAmount` VARCHAR(20) NULL,
    `language` VARCHAR(20) NULL,
    `aspectRatio` VARCHAR(20) NULL,
    `n` INTEGER NOT NULL DEFAULT 4,
    `refImageUrls` JSON NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'GENERATING',
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `GenerationTask_projectId_deletedAt_idx`(`projectId`, `deletedAt`),
    INDEX `GenerationTask_userId_status_createdAt_idx`(`userId`, `status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeneratedImage` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `taskId` INTEGER NOT NULL,
    `url` VARCHAR(1000) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'GENERATING',
    `providerJobId` VARCHAR(255) NULL,
    `errorMessage` TEXT NULL,
    `adopted` BOOLEAN NOT NULL DEFAULT false,
    `order` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `GeneratedImage_taskId_deletedAt_idx`(`taskId`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ImageProject` ADD CONSTRAINT `ImageProject_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductProfile` ADD CONSTRAINT `ProductProfile_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `ImageProject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BrandIdentity` ADD CONSTRAINT `BrandIdentity_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `ImageProject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductImage` ADD CONSTRAINT `ProductImage_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `ImageProject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GenerationTask` ADD CONSTRAINT `GenerationTask_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `ImageProject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GenerationTask` ADD CONSTRAINT `GenerationTask_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GeneratedImage` ADD CONSTRAINT `GeneratedImage_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `GenerationTask`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
