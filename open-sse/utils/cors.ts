/**
 * Static CORS headers for open-sse handlers.
 *
 * `Access-Control-Allow-Origin` is set by the Next.js middleware
 * (`src/server/cors/origins.ts`). Handlers in this package only need the
 * methods/headers list; the middleware overlays the allowed origin per
 * the central allowlist on the way out.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Expose-Headers":
    "X-OmniRoute-Provider, X-OmniRoute-Key-Index, X-OmniRoute-Selected-Connection-Id",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-api-key, anthropic-version, x-omniroute-connection, x-omniroute-provider, x-omniroute-key-index, x-omniroute-allow-cross-version-fallback, x-internal-test, accept",
};
