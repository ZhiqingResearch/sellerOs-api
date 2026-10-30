// src/image-generation/core/storage.ts
//
// Ported from amazon-agent:
//   - src/server/storage/spaces.ts (uploadBytesToSpaces / uploadRemoteUrlToSpaces
//     / base64ToBytes / extensionForMime + retry logic)
//   - src/lib/storage/scenes.ts (SPACES_SCENE_PREFIX / keyPrefixForScene)
//   - src/lib/storage/types.ts (GenerateUploadUrlRequest / Response)
//
// Behavior is kept verbatim except for one seam: the presign step. In the
// BFF it POSTs `${API_BASE}/api/spaces/upload-url` with the user's token; the
// default transport here does the same HTTP call against this backend's own
// `API_BASE_URL`, and `setSpacesPresignTransport` lets the Nest module swap
// in a direct SpacesService implementation later without touching callers.

import { jitter, sleep } from "./retry-utils";
import { randomUUID } from "node:crypto";
import { labelImage } from "../../aigc/image-label";
import { retryDelivery } from "../../aigc/aigc-metadata";
import { registerModerationUpload } from "../../content-moderation/moderation-scope";

// ─── Scene → keyPrefix catalogue (verbatim from @/lib/storage/scenes) ────────

export const SPACES_SCENE_PREFIX = {
  /** Wan-2.7-Pro reference image uploads (image-creation page). */
  IMAGE_CREATION_WAN_REF: "ai-creative/wan-refs/",
  /** OpenAI-compatible providers re-hosting base64 output (image-creation page). */
  IMAGE_CREATION_OUTPUT: "ai-creative/openai-compatible/",
  /** Product images uploaded via the image-creation page's main rail. */
  IMAGE_CREATION_PRODUCT_IMAGE: "ai-creative/product-images/",
  /** Paperclip-attached refs persisted with a task (refImageUrls). */
  IMAGE_CREATION_TASK_REF: "ai-creative/task-refs/",
  /** Brand-identity LOGO uploads. */
  IMAGE_CREATION_BRAND_LOGO: "ai-creative/brand-logos/",
  /** Brand reference image (品牌图片) uploads. */
  IMAGE_CREATION_BRAND_IMAGE: "ai-creative/brand-images/",
  /** Template image-entry 参考/示例图 (模板编辑器). */
  IMAGE_CREATION_TEMPLATE_REF: "ai-creative/template-refs/",
} as const;

export type SpacesScene = keyof typeof SPACES_SCENE_PREFIX;

export function keyPrefixForScene(scene: SpacesScene): string {
  return SPACES_SCENE_PREFIX[scene];
}

// ─── API contract for POST /api/spaces/upload-url (verbatim) ────────────────

export interface GenerateUploadUrlRequest {
  filename: string;
  contentType?: string;
  keyPrefix?: string;
  expiresIn?: number;
}

export interface GenerateUploadUrlResponse {
  uploadUrl: string;
  publicUrl: string;
  /** Request headers the client must send verbatim on the PUT to satisfy
   *  SigV4 (includes `x-amz-acl` and, when bound, `Content-Type`). */
  headers: Record<string, string>;
  key?: string;
  expiresAt?: string;
  expiresIn?: number;
}

// ─── Upload reliability knobs (verbatim) ─────────────────────────────────────

const UPLOAD_MAX_ATTEMPTS = 3;
const UPLOAD_BACKOFF_MS = [500, 1500];

/** Error carrying the HTTP status so the retry loop can tell a retryable
 *  transient (network / 429 / 5xx) from a permanent caller bug (4xx). */
class SpacesUploadError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SpacesUploadError";
    this.status = status;
  }
}

/** Undefined status ⇒ network-level fetch rejection (TypeError) — retryable.
 *  Otherwise only 408 / 429 / 5xx are worth another attempt. */
function isTransientUploadStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/** Run `fn` up to `UPLOAD_MAX_ATTEMPTS` times, backing off on transient
 *  failures. AbortErrors (caller timeout / cancel) propagate immediately and
 *  are never retried. */
async function withUploadRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      lastErr = err;
      const status =
        err instanceof SpacesUploadError ? err.status : undefined;
      if (!isTransientUploadStatus(status) || attempt === UPLOAD_MAX_ATTEMPTS) {
        break;
      }
      await sleep(jitter(UPLOAD_BACKOFF_MS[attempt - 1] ?? 2_000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(base64, "base64"));
  }
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function extensionForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  return ".png";
}

// ─── Presign transport seam ──────────────────────────────────────────────────

export interface SpacesPresignTransport {
  generateUploadUrl(
    authToken: string,
    body: GenerateUploadUrlRequest,
    signal?: AbortSignal,
  ): Promise<GenerateUploadUrlResponse>;
}

/** Default transport: same HTTP call the BFF made, pointed at this backend's
 *  own public base URL (`API_BASE_URL`). Swap via setSpacesPresignTransport. */
const httpPresignTransport: SpacesPresignTransport = {
  async generateUploadUrl(authToken, body, signal) {
    if (!authToken) {
      throw new Error("spaces upload requires authToken");
    }
    const base = process.env.API_BASE_URL;
    if (!base) {
      throw new Error("spaces upload requires API_BASE_URL to be set");
    }
    const url = `${base.replace(/\/$/, "")}/api/spaces/upload-url`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new SpacesUploadError(
        `spaces upload-url fetch failed: status=${response.status} body=${detail.slice(0, 300)}`,
        response.status,
      );
    }
    const parsed = (await response.json()) as Partial<GenerateUploadUrlResponse>;
    if (!parsed.uploadUrl || !parsed.publicUrl) {
      throw new SpacesUploadError(
        `spaces upload-url response missing fields: ${Object.keys(parsed).join(",")}`,
      );
    }
    return parsed as GenerateUploadUrlResponse;
  },
};

let presignTransport: SpacesPresignTransport = httpPresignTransport;

export function setSpacesPresignTransport(t: SpacesPresignTransport): void {
  presignTransport = t;
}

export function resetSpacesPresignTransport(): void {
  presignTransport = httpPresignTransport;
}

// ─── Public upload helpers (verbatim behavior) ───────────────────────────────

export interface UploadBytesToSpacesArgs {
  labelId?: string;
  /** Raw bytes to upload. */
  bytes: Uint8Array;
  /** MIME type — sent as `contentType` to the backend AND as the PUT
   *  `Content-Type` header. Backend binds the type into the signature, so a
   *  mismatch makes the PUT fail. */
  mimeType: string;
  /** Scene → keyPrefix lookup. Use `SpacesScene` enum keys. */
  scene: SpacesScene;
  /** Bearer token from the route layer. */
  authToken: string;
  /** Optional filename hint — only used for extension preservation. */
  filenameHint?: string;
  /** AbortSignal forwarded to both fetches so caller timeouts compose. */
  signal?: AbortSignal;
}

/**
 * Upload one chunk of bytes to Spaces and return the public URL.
 *
 * Used by image-creation providers:
 *   - atlas-wan.ts (reference images)
 *   - openai-compatible.ts (base64 outputs from gpt-image-2 etc.)
 */
export async function uploadBytesToSpaces(
  args: UploadBytesToSpacesArgs,
): Promise<string> {
  let { bytes, mimeType } = args;
  const { scene, authToken, filenameHint, signal } = args;
  if (scene === "IMAGE_CREATION_OUTPUT") {
    const id = args.labelId ?? randomUUID();
    const labeled = await retryDelivery(() => labelImage(Buffer.from(args.bytes), id));
    bytes = labeled.buffer;
    mimeType = labeled.mime;
  }
  const ext = extensionForMime(mimeType);
  const filename = filenameHint ?? `upload${ext}`;

  // Retry the whole presign+PUT as a unit: presigned URLs are single-use /
  // time-bound, so a transient PUT failure means we must request a fresh one
  // rather than re-PUT against a stale signature.
  return withUploadRetry(async () => {
    const presigned = await presignTransport.generateUploadUrl(
      authToken,
      {
        filename,
        contentType: mimeType,
        keyPrefix: keyPrefixForScene(scene),
      },
      signal,
    );

    // Forward `presigned.headers` verbatim — the signer bakes `x-amz-acl:
    // public-read` and the bound Content-Type into the signature; dropping
    // any of them either fails SigV4 or leaves the object private.
    const putResponse = await fetch(presigned.uploadUrl, {
      method: "PUT",
      headers: presigned.headers,
      body: bytes as unknown as BodyInit,
      signal,
    });
    if (!putResponse.ok) {
      const detail = await putResponse.text().catch(() => "");
      throw new SpacesUploadError(
        `spaces PUT failed: status=${putResponse.status} body=${detail.slice(0, 300)}`,
        putResponse.status,
      );
    }

    registerModerationUpload(presigned.key ?? presigned.publicUrl, presigned.publicUrl, bytes);
    return presigned.publicUrl;
  });
}

export interface UploadRemoteUrlToSpacesArgs {
  labelId?: string;
  /** Remote image URL to re-host (a provider gateway / CDN link). */
  url: string;
  /** Scene → keyPrefix lookup. */
  scene: SpacesScene;
  /** Bearer token from the route layer. */
  authToken: string;
  /** MIME to fall back to when the remote response omits Content-Type. */
  fallbackMime?: string;
  /** AbortSignal forwarded to the fetch + upload. */
  signal?: AbortSignal;
}

/**
 * Pull the bytes of a remote image URL server-side and re-host them to the
 * project's Space, returning the durable public URL.
 *
 * Exists because some upstreams hand back a short-lived URL on a host that
 * does not emit CORS headers; re-hosting must happen server-side.
 */
export async function uploadRemoteUrlToSpaces(
  args: UploadRemoteUrlToSpacesArgs,
): Promise<string> {
  const { url, scene, authToken, fallbackMime, signal } = args;

  // Fetch the source bytes (retryable on transient network / 5xx). The upload
  // step below has its own retry, so we only guard the download here.
  const { bytes, mimeType } = await withUploadRetry(async () => {
    const resp = await fetch(url, { signal, cache: "no-store" });
    if (!resp.ok) {
      throw new SpacesUploadError(
        `remote image fetch failed: status=${resp.status} url=${url.slice(0, 200)}`,
        resp.status,
      );
    }
    const ct = resp.headers.get("content-type")?.split(";")[0]?.trim();
    return {
      bytes: new Uint8Array(await resp.arrayBuffer()),
      mimeType: ct || fallbackMime || "image/png",
    };
  });

  return uploadBytesToSpaces({ bytes, mimeType, scene, authToken, signal, labelId: args.labelId });
}
