-- 统一 Avatar / Voice / Script.videoStatus 的状态集为 GENERATING / SUCCESS / FAILED
-- Script.videoStatus 允许 null，表示"尚未发起视频合成任务"

-- Avatar: WAIT → GENERATING
UPDATE `Avatar` SET `status` = 'GENERATING' WHERE `status` = 'WAIT';
ALTER TABLE `Avatar`
  MODIFY COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'GENERATING';

-- Voice: PREPARING / CLONING → GENERATING，FAIL → FAILED
UPDATE `Voice` SET `status` = 'GENERATING' WHERE `status` IN ('PREPARING', 'CLONING');
UPDATE `Voice` SET `status` = 'FAILED' WHERE `status` = 'FAIL';
ALTER TABLE `Voice`
  MODIFY COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'GENERATING';

-- Script.videoStatus: 先放开 NULL，再把 PENDING 归零
ALTER TABLE `Script`
  MODIFY COLUMN `videoStatus` VARCHAR(191) NULL;
UPDATE `Script` SET `videoStatus` = NULL WHERE `videoStatus` = 'PENDING';
