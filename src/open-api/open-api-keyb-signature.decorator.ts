import { SetMetadata } from "@nestjs/common"

export const OPEN_API_KEYB_SIGNATURE = "openApi:keybSignature"

/** 仅新 KeyB 入口启用 v2 签名，旧手机号入口继续使用原签名规则。 */
export const OpenApiKeybSignature = () => SetMetadata(OPEN_API_KEYB_SIGNATURE, true)
