import { retryAsync } from "./retry.js";

type FetchWithPreconnect = typeof fetch & {
  preconnect: (url: string, init?: { credentials?: RequestCredentials }) => void;
};

type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function isRetryableNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const code = (err as { code?: string }).code;
  if (code && RETRYABLE_ERROR_CODES.has(code)) return true;

  const cause = (err as { cause?: unknown }).cause;
  if (cause && isRetryableNetworkError(cause)) return true;

  const message = (err as { message?: string }).message;
  if (message && message.toLowerCase().includes("fetch failed")) return true;

  const name = (err as { name?: string }).name;
  if (name && (name === "TimeoutError" || name === "AbortError")) return true;

  return false;
}

export type FetchWithRetryOptions = {
  attempts?: number;
  timeoutMs?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
};

export function createFetchWithRetry(
  fetchImpl: typeof fetch,
  options: FetchWithRetryOptions = {},
): typeof fetch {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const minDelayMs = options.minDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 10_000;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return retryAsync(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const patchedInit = withDuplex(init, input);
          const response = await fetchImpl(input, {
            ...patchedInit,
            signal: controller.signal,
          });
          return response;
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        attempts,
        minDelayMs,
        maxDelayMs,
        jitter: 0.5,
        shouldRetry: isRetryableNetworkError,
      },
    );
  };
}

function withDuplex(
  init: RequestInit | undefined,
  input: RequestInfo | URL,
): RequestInit | undefined {
  const hasInitBody = init?.body != null;
  const hasRequestBody =
    !hasInitBody &&
    typeof Request !== "undefined" &&
    input instanceof Request &&
    input.body != null;
  if (!hasInitBody && !hasRequestBody) return init;
  if (init && "duplex" in (init as Record<string, unknown>)) return init;
  return init
    ? ({ ...init, duplex: "half" as const } as RequestInitWithDuplex)
    : ({ duplex: "half" as const } as RequestInitWithDuplex);
}

export function wrapFetchWithAbortSignal(fetchImpl: typeof fetch): typeof fetch {
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const patchedInit = withDuplex(init, input);
    const signal = patchedInit?.signal;
    if (!signal) return fetchImpl(input, patchedInit);
    if (typeof AbortSignal !== "undefined" && signal instanceof AbortSignal) {
      return fetchImpl(input, patchedInit);
    }
    if (typeof AbortController === "undefined") {
      return fetchImpl(input, patchedInit);
    }
    if (typeof signal.addEventListener !== "function") {
      return fetchImpl(input, patchedInit);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const response = fetchImpl(input, { ...patchedInit, signal: controller.signal });
    if (typeof signal.removeEventListener === "function") {
      void response.finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    }
    return response;
  }) as FetchWithPreconnect;

  const fetchWithPreconnect = fetchImpl as FetchWithPreconnect;
  wrapped.preconnect =
    typeof fetchWithPreconnect.preconnect === "function"
      ? fetchWithPreconnect.preconnect.bind(fetchWithPreconnect)
      : () => {};

  return Object.assign(wrapped, fetchImpl);
}

export function resolveFetch(fetchImpl?: typeof fetch): typeof fetch | undefined {
  const resolved = fetchImpl ?? globalThis.fetch;
  if (!resolved) return undefined;
  return wrapFetchWithAbortSignal(resolved);
}
