-- 公共形象 / 公共音色：镜像百度曦灵全量公共目录，客户添加后在 Avatar/Voice 表落一行 kind=PUBLIC
--
-- 要点：
-- 1. Avatar.figureId / Voice.perId 的全局唯一约束改为 (customerId, perId/figureId) 复合唯一：
--    同一公共 figureId/perId 可以被多个客户绑定。现有克隆数据本来跨客户不重复，不会误杀。
-- 2. 新增 kind 字段区分"克隆" / "公共"：CLONED / PUBLIC。现有行默认 CLONED，合现存语义。
-- 3. 新增 PublicAvatar / PublicVoice 镜像表，syncedAt + isActive 支撑 TTL 刷新和下架软失效。

-- 1. 去掉 Avatar.figureId / Voice.perId 的全局 unique
DROP INDEX `Avatar_figureId_key` ON `Avatar`;
DROP INDEX `Voice_perId_key` ON `Voice`;

-- 2. 新增 kind 字段（默认 CLONED，存量数据语义兼容）
ALTER TABLE `Avatar` ADD COLUMN `kind` VARCHAR(191) NOT NULL DEFAULT 'CLONED';
ALTER TABLE `Voice` ADD COLUMN `kind` VARCHAR(191) NOT NULL DEFAULT 'CLONED';

-- 3. 新建复合唯一 + kind 索引
CREATE UNIQUE INDEX `Avatar_customerId_figureId_key` ON `Avatar`(`customerId`, `figureId`);
CREATE INDEX `Avatar_customerId_kind_idx` ON `Avatar`(`customerId`, `kind`);
CREATE UNIQUE INDEX `Voice_customerId_perId_key` ON `Voice`(`customerId`, `perId`);
CREATE INDEX `Voice_customerId_kind_idx` ON `Voice`(`customerId`, `kind`);

-- 4. 公共形象镜像表
CREATE TABLE `PublicAvatar` (
  `id`               INTEGER       NOT NULL AUTO_INCREMENT,
  `figureId`         VARCHAR(191)  NOT NULL,
  `name`             VARCHAR(191)  NOT NULL,
  `item`             VARCHAR(191)  NOT NULL,
  `gender`           VARCHAR(191)  NULL,
  `age`              VARCHAR(191)  NULL,
  `pose`             VARCHAR(191)  NULL,
  `background`       VARCHAR(191)  NULL,
  `tags`             JSON          NULL,
  `templateImg`      VARCHAR(1000) NULL,
  `templateVideoUrl` VARCHAR(1000) NULL,
  `pictureUrl`       VARCHAR(1000) NULL,
  `maskVideoUrl`     VARCHAR(1000) NULL,
  `resolutionWidth`  INTEGER       NULL,
  `resolutionHeight` INTEGER       NULL,
  `aspectRatio`      VARCHAR(191)  NULL,
  `humanType`        VARCHAR(191)  NULL,
  `keepBackground`   BOOLEAN       NULL,
  `isActive`         BOOLEAN       NOT NULL DEFAULT true,
  `syncedAt`         DATETIME(3)   NOT NULL,
  `createdAt`        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`        DATETIME(3)   NOT NULL,

  UNIQUE INDEX `PublicAvatar_figureId_key`(`figureId`),
  INDEX        `PublicAvatar_isActive_gender_age_idx`(`isActive`, `gender`, `age`),
  INDEX        `PublicAvatar_isActive_humanType_aspectRatio_idx`(`isActive`, `humanType`, `aspectRatio`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 5. 公共音色镜像表
CREATE TABLE `PublicVoice` (
  `id`              INTEGER       NOT NULL AUTO_INCREMENT,
  `perId`           VARCHAR(191)  NOT NULL,
  `name`            VARCHAR(191)  NOT NULL,
  `describe`        VARCHAR(191)  NULL,
  `version`         VARCHAR(191)  NULL,
  `gender`          VARCHAR(191)  NULL,
  `exampleAudioUrl` VARCHAR(1000) NULL,
  `age`             VARCHAR(191)  NULL,
  `style`           VARCHAR(191)  NULL,
  `language`        JSON          NULL,
  `capability`      VARCHAR(191)  NULL,
  `feature`         VARCHAR(191)  NULL,
  `latency`         VARCHAR(191)  NULL,
  `isActive`        BOOLEAN       NOT NULL DEFAULT true,
  `syncedAt`        DATETIME(3)   NOT NULL,
  `createdAt`       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`       DATETIME(3)   NOT NULL,

  UNIQUE INDEX `PublicVoice_perId_key`(`perId`),
  INDEX        `PublicVoice_isActive_gender_idx`(`isActive`, `gender`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
