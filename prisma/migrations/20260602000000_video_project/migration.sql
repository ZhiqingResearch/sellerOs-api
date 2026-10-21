-- 视频创作 - 通用创作：新增 VideoProject / VideoTask 两张表

-- 视频项目
CREATE TABLE `VideoProject` (
  `id`        INTEGER NOT NULL AUTO_INCREMENT,
  `name`      VARCHAR(200) NOT NULL DEFAULT '未命名项目',
  `userId`    INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `deletedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `VideoProject_userId_deletedAt_idx`(`userId`, `deletedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 视频生成任务（任务中心一条 = 一个输出视频）
CREATE TABLE `VideoTask` (
  `id`              INTEGER NOT NULL AUTO_INCREMENT,
  `projectId`       INTEGER NOT NULL,
  `userId`          INTEGER NOT NULL,
  `mode`            VARCHAR(20) NOT NULL,
  `prompt`          TEXT NOT NULL,
  `model`           VARCHAR(30) NOT NULL,
  `durationSec`     INTEGER NOT NULL DEFAULT 6,
  `aspectRatio`     VARCHAR(20) NULL,
  `resolution`      VARCHAR(20) NULL,
  `generateAudio`   BOOLEAN NOT NULL DEFAULT false,
  `keepSourceAudio` BOOLEAN NOT NULL DEFAULT false,
  `firstFrameUrl`   VARCHAR(1000) NULL,
  `lastFrameUrl`    VARCHAR(1000) NULL,
  `refMaterials`    JSON NULL,
  `status`          VARCHAR(191) NOT NULL DEFAULT 'GENERATING',
  `providerJobId`   VARCHAR(255) NULL,
  `resultUrl`       VARCHAR(1000) NULL,
  `thumbnailUrl`    VARCHAR(1000) NULL,
  `errorMessage`    TEXT NULL,
  `createdAt`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`       DATETIME(3) NOT NULL,
  `deletedAt`       DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `VideoTask_projectId_deletedAt_idx`(`projectId`, `deletedAt`),
  INDEX `VideoTask_userId_status_createdAt_idx`(`userId`, `status`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `VideoProject` ADD CONSTRAINT `VideoProject_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `VideoTask` ADD CONSTRAINT `VideoTask_projectId_fkey`
  FOREIGN KEY (`projectId`) REFERENCES `VideoProject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `VideoTask` ADD CONSTRAINT `VideoTask_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
