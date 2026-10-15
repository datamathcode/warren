/**
 * Cap on a request body, in bytes.
 *
 * This is Bun's own default (`maxRequestBodySize`). `startServer` passes
 * it explicitly. Bun answers 413 and never calls the fetch handler when
 * the body is larger, so `request.clone().text()` in the schema check
 * does not run for an oversized body. The schema check also refuses a
 * declared `Content-Length` over this cap before it reads.
 */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024 * 128;
