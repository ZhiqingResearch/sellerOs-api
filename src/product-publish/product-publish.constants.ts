export const PRODUCT_PUBLISH_CLASSIFICATIONS = [
  { code: "NOTEBOOK COMPUTER", name: "laptop", templateFilename: "NOTEBOOK_COMPUTER.xlsm" },
  { code: "TABLET COMPUTER", name: "Tablet Computer", templateFilename: "TABLET_COMPUTER.xlsm" },
  {
    code: "ELECTRONIC DEVICE DOCKING STATION",
    name: "Electronic Device Docking Station",
    templateFilename: "ELECTRONIC_DEVICE_DOCKING_STATION.xlsm",
  },
  {
    code: "WEARABLE COMPUTER",
    name: "Wearable Computer",
    templateFilename: "WEARABLE_COMPUTER.xlsm",
  },
  { code: "SPEAKERS", name: "Speaker", templateFilename: "SPEAKERS.xlsm" },
  {
    code: "KEYBOARD MOUSE SET",
    name: "Keyboard & Mouse Set",
    templateFilename: "KEYBOARD_MOUSE_SET.xlsm",
  },
  { code: "KEYBOARDS", name: "Keyboard", templateFilename: "KEYBOARDS.xlsm" },
  { code: "PERSONAL COMPUTER", name: "Desktop", templateFilename: "PERSONAL_COMPUTER.xlsm" },
  { code: "MULTIPORT HUB", name: "Multiport Hub", templateFilename: "MULTIPORT_HUB.xlsm" },
  { code: "CAMCORDER", name: "Camcorder", templateFilename: "CAMCORDER.xlsm" },
  { code: "HEADPHONES", name: "Headphones", templateFilename: "HEADPHONES.xlsm" },
  {
    code: "CONSOLE VIDEO GAMES",
    name: "CONSOLE_VIDEO_GAMES",
    templateFilename: "CONSOLE_VIDEO_GAMES.xlsm",
  },
] as const

export type ProductPublishClassificationCode =
  (typeof PRODUCT_PUBLISH_CLASSIFICATIONS)[number]["code"]

export const PRODUCT_PUBLISH_CLASSIFICATION_CODES = PRODUCT_PUBLISH_CLASSIFICATIONS.map(
  item => item.code
)
export const PRODUCT_PUBLISH_TYPES = ["SINGLE", "VARIANT"] as const
export const PRODUCT_PUBLISH_STATUSES = ["DRAFT", "PUBLISHING", "COMPLETED"] as const
export const WASH_STATUSES = ["PENDING", "SUCCESS", "FAILED"] as const

export const TEMPLATE_KEY_PREFIX = "product-publish/templates"
export const EXPORT_KEY_PREFIX = "product-publish/exports"
