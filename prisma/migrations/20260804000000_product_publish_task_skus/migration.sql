-- ProductPublishTask 保存首次提交上架时冻结的 SKU 列表。
-- 字段保持可空以兼容部署前已经存在的历史任务；新提交由接口强制要求非空列表。
ALTER TABLE `ProductPublishTask`
    ADD COLUMN `skus` JSON NULL;
