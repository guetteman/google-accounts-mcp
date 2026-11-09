// Page actions and public OAuth forms share one byte limit.
export const MAX_BODY_BYTES = 16 * 1024;

/** Buffer at most the limit, cancel on overflow, and preserve the original bytes. */
export async function limitRequestBody(request: Request): Promise<Request | Response> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_BODY_BYTES - size) {
        await reader.cancel();
        return new Response("Payload too large", { status: 413 });
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bounded = new Request(request, { method: request.method, body: bytes.subarray(0, size) });
  bounded.headers.delete("Content-Length");
  return bounded;
}
