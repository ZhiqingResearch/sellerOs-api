import { SetMetadata } from "@nestjs/common"

export const PERMISSIONS_METADATA_KEY = "permissions"

export const RequirePermissions = (...keys: string[]) => SetMetadata(PERMISSIONS_METADATA_KEY, keys)
