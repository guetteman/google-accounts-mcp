import { Effect, Result } from "effect";
import { readConfig } from "../config";
import type { GatedEnv } from "../owner/gate";
import { isoSeconds } from "../approvals/model";
import { MAX_FORWARD_BYTES } from "../google/forward";
import { liveLink, parseUploadId, storeFile } from "./store";

export const UPLOAD_PATH = "/uploads/";
const json = (status: number, code: string, message: string) =>
  Response.json({ code, message }, { status, headers: { "Cache-Control": "no-store" } });
const unavailable = () =>
  json(
    503,
    "server_unavailable",
    "The server could not store the file. Try again with a new upload link.",
  );
const missing = () =>
  json(
    404,
    "upload_link_not_available",
    "This upload link is not available. A link takes one file, once, before it expires. If your upload did not answer with an upload ID, call create_upload_link for a new link.",
  );
const tooLarge = () =>
  json(
    413,
    "upload_too_large",
    `The file is larger than the limit of ${MAX_FORWARD_BYTES.toLocaleString("en-US")} bytes.`,
  );
const filenameOf = (raw: string): string | null => {
  try {
    const name = decodeURIComponent(raw);
    // oxlint-disable-next-line no-control-regex -- File names cannot contain controls or path separators.
    return name && Array.from(name).length <= 200 && !/[\u0000-\u001f\u007f-\u009f/\\]/.test(name)
      ? name
      : null;
  } catch {
    return null;
  }
};
const mediaType = (value: string | null) => {
  const type = (value ?? "").split(";")[0]!.trim().toLowerCase();
  return type.length <= 100 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)
    ? type
    : "application/octet-stream";
};
type Fetch = (
  request: Request,
  env: GatedEnv,
  ctx: ExecutionContext,
) => Response | Promise<Response>;
export const withUploadLink =
  (inner: Fetch): Fetch =>
  async (request, env, execution) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(UPLOAD_PATH)) return inner(request, env, execution);
    const [link, ...rest] = url.pathname.slice(UPLOAD_PATH.length).split("/");
    if (request.method !== "PUT" || !parseUploadId(link)) return missing();
    const config = readConfig(env);
    if (Result.isFailure(config)) return unavailable();
    const ctx = {
      db: env.DB,
      files: env.FILES_KV,
      config: config.success,
      owner: { generation: env.ownerGeneration, email: config.success.ownerEmail },
    };
    try {
      if (!(await Effect.runPromise(liveLink(ctx, link!, Date.now())))) return missing();
      const filename = filenameOf(rest.join("/"));
      if (filename === null)
        return json(
          400,
          "invalid_upload",
          `Put the file's name after the link, as in ${url.origin}${UPLOAD_PATH}${link}/report.pdf.`,
        );
      const contentType = (request.headers.get("Content-Type") ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      if (
        contentType.startsWith("multipart/") ||
        contentType === "application/x-www-form-urlencoded"
      )
        return json(
          400,
          "invalid_upload",
          `Send the file's bytes as the body of the PUT request, not as a form. With curl: curl -T <path> '${request.url}'.`,
        );
      if (Number(request.headers.get("Content-Length")) > MAX_FORWARD_BYTES) return tooLarge();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = request.body?.getReader();
      if (reader) {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_FORWARD_BYTES) {
            await reader.cancel();
            return tooLarge();
          }
          chunks.push(next.value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const type = mediaType(request.headers.get("Content-Type"));
      const stored = await Effect.runPromise(
        storeFile(ctx, link!, { filename, type, bytes, charset: null }, Date.now()),
      );
      return stored
        ? Response.json(
            {
              upload: stored.upload,
              filename,
              type,
              size,
              expires_at: isoSeconds(stored.expiresAt),
            },
            { status: 201, headers: { "Cache-Control": "no-store" } },
          )
        : missing();
    } catch {
      return unavailable();
    }
  };
