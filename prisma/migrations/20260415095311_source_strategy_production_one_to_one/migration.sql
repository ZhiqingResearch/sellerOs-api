-- AlterTable: Add unique constraint on projectId for one-to-one relationships

-- Source: projectId unique
CREATE UNIQUE INDEX `Source_projectId_key` ON `Source`(`projectId`);

-- Strategy: projectId unique
CREATE UNIQUE INDEX `Strategy_projectId_key` ON `Strategy`(`projectId`);

-- Production: projectId unique
CREATE UNIQUE INDEX `Production_projectId_key` ON `Production`(`projectId`);
