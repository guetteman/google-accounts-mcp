import { Schema, Result } from "effect";
import { FileRef } from "../files/store";
import type { TokenKey } from "../config";
import { open, seal, type Sealed } from "../seal";
import type { ApprovalId, StoredPayload } from "./model";

export const sealArguments = (key: TokenKey, id: ApprovalId, args: unknown): Promise<Sealed> =>
  seal(key, `${id}:arguments`, JSON.stringify(args));
export async function openArguments(
  key: TokenKey,
  id: ApprovalId,
  sealed: Sealed,
): Promise<unknown> {
  const opened = await open(key, `${id}:arguments`, sealed);
  return opened.ok ? JSON.parse(opened.value) : null;
}
export const sealResult = (
  key: TokenKey,
  id: ApprovalId,
  payload: StoredPayload,
): Promise<Sealed> => seal(key, `${id}:result`, JSON.stringify(payload));
export async function openResult(
  key: TokenKey,
  id: ApprovalId,
  sealed: Sealed,
): Promise<StoredPayload | null> {
  const opened = await open(key, `${id}:result`, sealed);
  if (!opened.ok) return null;
  const parsed: unknown = JSON.parse(opened.value);
  if (typeof parsed !== "object" || parsed === null) return null;
  if ("result" in parsed) {
    const file = "file" in parsed ? Schema.decodeUnknownResult(FileRef)(parsed.file) : null;
    return {
      result: parsed.result,
      ...(file && Result.isSuccess(file) ? { file: file.success } : {}),
    };
  }
  if (
    "error" in parsed &&
    typeof parsed.error === "object" &&
    parsed.error !== null &&
    "code" in parsed.error &&
    typeof parsed.error.code === "string" &&
    "message" in parsed.error &&
    typeof parsed.error.message === "string"
  )
    return { error: { code: parsed.error.code, message: parsed.error.message } };
  return null;
}
