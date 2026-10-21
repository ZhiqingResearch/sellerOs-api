// Route-facing glue for the target-size delivery system.
//
// Keeps the side-effectful bits (fetching provider bytes, running sharp) out of
// the route handler while leaving the provider GENERATION path untouched: this
// is a post-step that forces exact target pixels on an already-generated image.
// Engaged only for explicit pixel targets (customSizeMode === "pixels"); ratio
// requests keep their current behavior. See target-size-delivery-system-v2.md.

import { base64ToBytes } from "./storage";

import { plan } from "./delivery-planner";
import { finalize, verifyDeliverySize } from "./image-finalizer";
import type { DeliveryPlan } from "./delivery-types";
import type { ProductImageGenerateForm } from "./types";

/** Returns a DeliveryPlan iff the form carries an explicit W×H pixel target.
 *  Null means "leave the legacy flow alone". */
export function deliveryPlanForForm(form: ProductImageGenerateForm): DeliveryPlan | null {
  const isPixels =
    form.customSizeMode === "pixels" &&
    typeof form.customAspectW === "number" &&
    form.customAspectW > 0 &&
    typeof form.customAspectH === "number" &&
    form.customAspectH > 0;
  if (!isPixels) return null;

  const deliveryPlan = plan({
    targetWidth: Math.round(form.customAspectW as number),
    targetHeight: Math.round(form.customAspectH as number),
    resolutionTier: form.resolutionTier,
  });
  if (deliveryPlan.finalizer.fit === "cover") deliveryPlan.finalizer.anchor = "center";
  return deliveryPlan;
}

async function loadBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (url.startsWith("data:")) {
    const base64 = url.split(",")[1] ?? "";
    return base64ToBytes(base64);
  }
  // Provider relay URLs are public and short-lived (~15min); fetch promptly.
  const resp = await fetch(url, signal ? { signal } : undefined);
  if (!resp.ok) {
    throw new Error(`failed to fetch generated image for finalize: ${resp.status}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

export interface FinalizedImage {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  deliveryStrategy: string;
  qaStatus: "pass" | "fail";
}

/** Download the generated image, force it to the plan's exact target size, and
 *  return the finalized bytes + audit metadata. Caller uploads + persists. */
export async function finalizeGeneratedImage(
  url: string,
  deliveryPlan: DeliveryPlan,
  signal?: AbortSignal,
): Promise<FinalizedImage> {
  const bytes = await loadBytes(url, signal);
  const result = await finalize(bytes, deliveryPlan.finalizer);
  const qa = verifyDeliverySize(result, deliveryPlan.finalizer);
  return {
    bytes: result.buffer,
    mimeType: `image/${result.format}`,
    width: result.width,
    height: result.height,
    deliveryStrategy: deliveryPlan.strategy,
    qaStatus: qa.status,
  };
}
