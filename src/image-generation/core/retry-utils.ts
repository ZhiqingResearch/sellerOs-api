// src/server/image/retry-utils.ts
//
// Shared retry / error-classification toolkit for image providers.
//
// The nananobanana relay, the OpenAI official Images API, and AtlasCloud all
// share the same failure topology (auth / validation / policy / quota are
// permanent; network / timeout / 429 / 5xx / generic body errors are
// transient) but each has its own response schema. We centralise:
//
//   - `FailureKind` taxonomy and friendly Chinese messages
//   - HTTP status → kind classifier
//   - body-text → kind classifier (keyword-based)
//   - `RelayError` — the internal throw type carrying classification + details
//   - `runAttempt` — a single HTTP POST attempt with timeout + abort handling
//
// `runAttempt` takes a parser callback so each provider supplies its own
// response-shape handling. The parser either returns an `AttemptResult` or
// throws a `RelayError` with provider-specific classification. Network /
// timeout / non-OK HTTP status errors are handled uniformly here.
//
// The retry LOOP itself still lives in each provider — providers have
// different attempt counts / backoff schedules / logging prefixes, and the
// loop is small enough that duplicating it beats forcing a shared interface
// with dozens of knobs.

export type FailureKind =
  | "transient_network"
  | "transient_timeout"
  | "transient_rate_limit"
  | "transient_server"
  | "transient_body"
  | "permanent_auth"
  | "permanent_quota"
  | "permanent_policy"
  | "permanent_validation"
  | "permanent_unknown";

const TRANSIENT_BODY_HINTS = [
  "timeout",
  "timed out",
  "rate limit",
  "too many",
  "unavailable",
  "upstream",
  "gateway",
  "bad gateway",
  "retry",
  "temporar",
  "overload",
  "busy",
  "server error",
  "internal error",
  "generation failed",
  "try again",
  "no image",
  "empty",
];

const PERMANENT_AUTH_HINTS = [
  "api key",
  "unauthori",
  "forbidden",
  "invalid key",
  "no credit",
  "insufficient",
];

const PERMANENT_POLICY_HINTS = [
  "policy",
  "safety",
  "blocked",
  "violat",
  "not allowed",
  "rejected",
  "inappropriate",
  "content_policy",
];

const PERMANENT_VALIDATION_HINTS = [
  "field required",
  "is required",
  "missing required",
  "unrecognized field",
  "unsupported",
  "invalid value",
  "invalid parameter",
  "invalid request",
  "must be",
  "must have",
  "validation error",
  "schema",
  "bad request",
];

export function classifyHttpStatus(status: number): FailureKind {
  if (status === 401 || status === 403) return "permanent_auth";
  if (status === 400 || status === 404 || status === 422) {
    return "permanent_validation";
  }
  if (status === 402) return "permanent_quota";
  if (status === 429) return "transient_rate_limit";
  if (status >= 500 && status < 600) return "transient_server";
  if (status === 408) return "transient_timeout";
  return "permanent_unknown";
}

export function classifyBodyMessage(raw: string | undefined | null): FailureKind {
  const msg = (raw || "").toLowerCase();
  if (!msg) return "transient_body";
  if (PERMANENT_AUTH_HINTS.some((h) => msg.includes(h))) return "permanent_auth";
  if (PERMANENT_POLICY_HINTS.some((h) => msg.includes(h))) return "permanent_policy";
  if (msg.includes("quota") || msg.includes("credit")) return "permanent_quota";
  if (PERMANENT_VALIDATION_HINTS.some((h) => msg.includes(h))) return "permanent_validation";
  if (TRANSIENT_BODY_HINTS.some((h) => msg.includes(h))) return "transient_body";
  // Unknown body error — lean transient so we give it one more shot; the
  // classifier guards permanent cases above.
  return "transient_body";
}

export function isTransient(kind: FailureKind): boolean {
  return kind.startsWith("transient_");
}

export function friendlyMessage(kind: FailureKind): string {
  switch (kind) {
    case "transient_network":
      return "网络连接异常，请检查网络后重试";
    case "transient_timeout":
      return "生成超时，请稍后重试";
    case "transient_rate_limit":
      return "模型请求过于频繁，请稍后再试";
    case "transient_server":
    case "transient_body":
      return "图像服务繁忙，请稍后重试";
    case "permanent_auth":
      return "图像服务配置异常，请联系管理员";
    case "permanent_quota":
      return "图像服务额度不足，请联系管理员";
    case "permanent_policy":
      return "提示词涉及敏感或不允许的内容，已被服务拒绝";
    case "permanent_validation":
      return "参数不合法，无法生成此图";
    case "permanent_unknown":
    default:
      return "生成失败，请稍后重试";
  }
}

/** Unified message for size/aspect-ratio/resolution rejections — these are a
 *  model capability limit, not a bug the user can fix by rewording, so they get
 *  one clear line instead of the raw upstream text. Exported for gateway
 *  providers to use when classifying failed tasks. */
export const SIZE_ERROR_MESSAGE = "该模型不支持此比例/清晰度";

/** Substrings (lower-cased) that mark an upstream error as size/dimension/
 *  aspect-ratio related. Kept specific to avoid misclassifying unrelated
 *  validation errors (e.g. a bare "size" could be prompt length). */
const SIZE_ERROR_HINTS = [
  "width",
  "height",
  "dimension",
  "resolution",
  "aspect",
  "ratio",
  "pixel",
  "megapixel",
  "image size",
  "output size",
  "invalid size",
  "unsupported size",
  "size must",
  // 网关 size 准入边界 400（2026-09-14 实测文案 "size '1024x307' is below
  // the minimum edge 512px"）—— 同属模型/网关尺寸能力约束，归尺寸文案。
  "minimum edge",
  "maximum edge",
  "尺寸",
  "分辨率",
  "比例",
];

/** True when the error (message or attached upstream `cause`) looks like a
 *  size / aspect-ratio / resolution rejection. */
export function isSizeRelatedError(err: unknown): boolean {
  const base = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && typeof err.cause === "string" ? err.cause : "";
  const text = `${base}\n${cause}`.toLowerCase();
  return SIZE_ERROR_HINTS.some((h) => text.includes(h));
}

/** Build the user-facing failure string for an image-generation error.
 *
 *  - Size/aspect/resolution rejections collapse to a single friendly line
 *    ("该模型不支持此比例/清晰度") regardless of the upstream wording.
 *  - Otherwise, when a provider attaches the raw upstream error as the Error
 *    `cause` (a string), append it after the friendly summary so the frontend
 *    surfaces the REAL reason (e.g. which field the model rejected) instead of
 *    only the generic "参数不合法" line. Providers that don't set a string
 *    cause are unaffected — the message is returned verbatim. */
export function describeImageError(err: unknown): string {
  if (isSizeRelatedError(err)) return SIZE_ERROR_MESSAGE;
  const base = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && typeof err.cause === "string"
      ? err.cause.trim()
      : "";
  if (!cause || cause === base) return base;
  const capped = cause.length > 300 ? `${cause.slice(0, 300)}…` : cause;
  return `${base}（上游返回：${capped}）`;
}

export function parseRetryAfterHeader(
  value: string | null | undefined,
): number | null {
  const raw = value?.trim();
  if (!raw) return null;

  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && /^\d+$/.test(raw) && seconds > 0) {
    return seconds * 1000;
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;

  const delayMs = at - Date.now();
  return delayMs > 0 ? delayMs : null;
}

/**
 * Internal throw type. Carries the classified kind + a developer-facing
 * `details` string for logging. `.message` is already the user-friendly
 * Chinese string so top-level callers can unwrap into `new Error(e.message)`
 * without another lookup.
 */
export class RelayError extends Error {
  kind: FailureKind;
  details: string;
  status?: number;
  retryAfterMs?: number;
  constructor(
    kind: FailureKind,
    friendly: string,
    details: string,
    status?: number,
    retryAfterMs?: number,
  ) {
    super(friendly);
    this.kind = kind;
    this.details = details;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** ±30% so concurrent retries don't re-converge on the same upstream. */
export function jitter(baseMs: number): number {
  const factor = 0.7 + Math.random() * 0.6;
  return Math.round(baseMs * factor);
}

// ─── Single-attempt HTTP helper ────────────────────────────────────────────

export interface RunAttemptOptions {
  /** Full request URL. */
  url: string;
  /** Per-attempt timeout. Aborts the underlying fetch. */
  timeoutMs: number;
  /** Caller-provided cancellation signal (e.g. request.signal). */
  externalSignal?: AbortSignal;
  /**
   * Request body. Either a JSON-serialisable object (serialised + Content-Type
   * json) or a pre-built Body (FormData / Blob / Uint8Array / string). For
   * FormData the Content-Type header is deliberately NOT set — fetch fills it
   * with the boundary automatically.
   */
  body: Record<string, unknown> | BodyInit;
  /** Extra headers merged on top of Authorization + content-type defaults. */
  headers?: Record<string, string>;
  /** Bearer token for the Authorization header. Required. */
  apiKey: string;
  /**
   * HTTP method — defaults to POST since every image provider here uses POST
   * for the primary call.
   */
  method?: string;
  /**
   * Optional undici Dispatcher (typically a `ProxyAgent`) for this request.
   * Providers that reach upstreams unreachable from the app's default egress
   * (e.g. api.openai.com from a mainland-China host) wire a proxy here. Kept
   * as `unknown` at this layer so retry-utils doesn't force a hard dependency
   * on undici's types — the caller casts at the fetch boundary.
   */
  dispatcher?: unknown;
}

export interface AttemptContext {
  status: number;
  bodyText: string;
}

/**
 * Parser callback. Receives the raw response text + status and must either
 * return the provider's success shape or throw a `RelayError` with a
 * provider-specific classification (e.g. content-policy on a 200 body).
 */
export type AttemptParser<T> = (ctx: AttemptContext) => T;

function isPlainObject(body: unknown): body is Record<string, unknown> {
  return (
    !!body &&
    typeof body === "object" &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    !(body instanceof ArrayBuffer) &&
    !(body instanceof Uint8Array) &&
    typeof body !== "string"
  );
}

/**
 * Execute ONE HTTP attempt against an image provider. Handles:
 *   - Abort plumbing: merges external signal + per-attempt timeout signal;
 *     external aborts propagate as AbortError (route recognises this and
 *     does NOT count it as a failure)
 *   - Non-OK responses: classified via HTTP status, thrown as RelayError
 *   - Parser-driven success / permanent-failure handling: parser sees 2xx
 *     bodies and can still throw RelayError if the provider returned an
 *     error payload at 200 (e.g. content_policy_violation)
 *
 * Does NOT implement retry — providers wrap this in their own loop.
 */
export async function runAttempt<T>(
  opts: RunAttemptOptions,
  parse: AttemptParser<T>,
): Promise<T> {
  const {
    url,
    timeoutMs,
    externalSignal,
    body,
    headers = {},
    apiKey,
    method = "POST",
    dispatcher,
  } = opts;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort);
  }

  // Serialise body if it's a plain object; otherwise pass through.
  const requestInit: RequestInit = {
    method,
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...headers,
    },
  };
  if (isPlainObject(body)) {
    requestInit.body = JSON.stringify(body);
    (requestInit.headers as Record<string, string>)["Content-Type"] =
      (headers["Content-Type"] as string | undefined) || "application/json";
  } else {
    requestInit.body = body as BodyInit;
    // For FormData we intentionally do NOT set Content-Type — the fetch
    // runtime fills in the multipart boundary. Callers that pass raw strings
    // or Uint8Array should set Content-Type themselves via `headers`.
  }
  if (dispatcher) {
    // Node's fetch (undici) accepts a non-standard `dispatcher` option on
    // RequestInit. The DOM typings don't include it, hence the cast.
    (requestInit as unknown as { dispatcher: unknown }).dispatcher = dispatcher;
  }

  let response: Response;
  try {
    response = await fetch(url, requestInit);
  } catch (err) {
    if (externalSignal?.aborted) {
      const abortErr = err instanceof Error ? err : new Error(String(err));
      if (abortErr.name !== "AbortError") abortErr.name = "AbortError";
      throw abortErr;
    }
    if (timedOut) {
      throw new RelayError(
        "transient_timeout",
        friendlyMessage("transient_timeout"),
        `timeout after ${timeoutMs}ms`,
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new RelayError(
      "transient_network",
      friendlyMessage("transient_network"),
      detail,
    );
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }

  const bodyText = await response.text();

  if (!response.ok) {
    // Try to pull a more specific kind out of the body (e.g. permanent_policy)
    // before falling back to the status-code-only classifier. This matters
    // most for 400s where OpenAI returns content-policy errors.
    const statusKind = classifyHttpStatus(response.status);
    let kind = statusKind;
    if (statusKind === "permanent_validation" || statusKind === "permanent_unknown") {
      const bodyKind = classifyBodyMessage(bodyText);
      if (bodyKind === "permanent_policy" || bodyKind === "permanent_auth") {
        kind = bodyKind;
      }
    }
    const retryAfterMs =
      kind === "transient_rate_limit"
        ? parseRetryAfterHeader(response.headers.get("retry-after"))
        : undefined;
    throw new RelayError(
      kind,
      friendlyMessage(kind),
      `status=${response.status} body=${bodyText.slice(0, 2000)}`,
      response.status,
      retryAfterMs ?? undefined,
    );
  }

  return parse({ status: response.status, bodyText });
}
