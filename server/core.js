/**
 * Stream utilities from Node.js core
 * Used for handling request/response streaming safely
 */
import { Readable } from "node:stream";

/**
 * Promise-based pipeline for robust stream piping with error handling
 */
import { pipeline } from "node:stream/promises";

/**
 * API route configuration (commonly used in Next.js / Vercel environments)
 */
export const config = {
  /**
   * Disable automatic body parsing
   * Required when working with raw streams
   */
  api: { bodyParser: false },

  /**
   * Enables streaming responses to the client
   */
  supportsResponseStreaming: true,

  /**
   * Maximum execution time (in seconds)
   */
  maxDuration: 60,
};

/**
 * Upstream base URL (target server)
 * Removes trailing slash to avoid malformed URLs
 */
const UPSTREAM_BASE_URL = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

/**
 * Headers that must be excluded from forwarding
 * Prevents protocol conflicts and proxy loops
 */
const BLOCKED_HEADER_SET = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

/**
 * Main handler function acting as a reverse proxy
 */
export default async function proxyHandler(incomingReq, outgoingRes) {
  /**
   * Ensure upstream target is defined
   */
  if (!UPSTREAM_BASE_URL) {
    outgoingRes.statusCode = 500;
    return outgoingRes.end("Configuration Error: TARGET_DOMAIN is missing");
  }

  try {
    /**
     * Build full target URL using incoming request path
     */
    const destinationUrl = UPSTREAM_BASE_URL + incomingReq.url;

    /**
     * Container for sanitized headers
     */
    const sanitizedHeaders = {};

    /**
     * Stores detected client IP address
     */
    let detectedClientIp = null;

    /**
     * Iterate through incoming headers
     */
    for (const headerName of Object.keys(incomingReq.headers)) {
      const normalizedKey = headerName.toLowerCase();
      const headerValue = incomingReq.headers[headerName];

      /**
       * Skip blocked headers
       */
      if (BLOCKED_HEADER_SET.has(normalizedKey)) continue;

      /**
       * Skip platform-specific headers (e.g., Vercel)
       */
      if (normalizedKey.startsWith("x-vercel-")) continue;

      /**
       * Capture real client IP if available
       */
      if (normalizedKey === "x-real-ip") {
        detectedClientIp = headerValue;
        continue;
      }

      /**
       * Fallback to x-forwarded-for if x-real-ip is not present
       */
      if (normalizedKey === "x-forwarded-for") {
        if (!detectedClientIp) detectedClientIp = headerValue;
        continue;
      }

      /**
       * Normalize header value (handle array values)
       */
      sanitizedHeaders[normalizedKey] = Array.isArray(headerValue)
        ? headerValue.join(", ")
        : headerValue;
    }

    /**
     * Inject client IP into forwarded headers
     */
    if (detectedClientIp) {
      sanitizedHeaders["x-forwarded-for"] = detectedClientIp;
    }

    /**
     * Extract HTTP method
     */
    const httpMethod = incomingReq.method;

    /**
     * Determine if request includes a body
     */
    const shouldStreamBody =
      httpMethod !== "GET" && httpMethod !== "HEAD";

    /**
     * Fetch options for upstream request
     */
    const upstreamRequestOptions = {
      method: httpMethod,
      headers: sanitizedHeaders,
      redirect: "manual", // Prevent auto-follow redirects
    };

    /**
     * Attach request body as stream if applicable
     */
    if (shouldStreamBody) {
      upstreamRequestOptions.body = Readable.toWeb(incomingReq);

      /**
       * Required for streaming request body in Node.js fetch
       */
      upstreamRequestOptions.duplex = "half";
    }

    /**
     * Perform request to upstream server
     */
    const upstreamResponse = await fetch(
      destinationUrl,
      upstreamRequestOptions
    );

    /**
     * Mirror upstream status code
     */
    outgoingRes.statusCode = upstreamResponse.status;

    /**
     * Forward response headers
     */
    for (const [responseHeaderKey, responseHeaderValue] of upstreamResponse.headers) {
      /**
       * Skip problematic headers
       */
      if (responseHeaderKey.toLowerCase() === "transfer-encoding") continue;

      try {
        outgoingRes.setHeader(responseHeaderKey, responseHeaderValue);
      } catch {
        /**
         * Ignore restricted header errors
         */
      }
    }

    /**
     * Stream response body to client
     */
    if (upstreamResponse.body) {
      await pipeline(
        Readable.fromWeb(upstreamResponse.body),
        outgoingRes
      );
    } else {
      /**
       * End response if no body exists
       */
      outgoingRes.end();
    }
  } catch (proxyError) {
    /**
     * Log proxy errors for debugging
     */
    console.error("proxy failure:", proxyError);

    /**
     * Send fallback error response
     */
    if (!outgoingRes.headersSent) {
      outgoingRes.statusCode = 502;
      outgoingRes.end("Bad Gateway: Proxy Error");
    }
  }
}