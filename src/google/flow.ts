import { Data, Result, Schema } from "effect";
import { hostCookie, readCookie } from "../http/cookies";
import { returnPath, type ReturnPath } from "../http/return-path";
import { base64url, decodeBase64url, randomToken } from "../lib/crypto";
import { GenerationSchema, type Generation } from "../owner/owner";

export interface GoogleFlow {
  readonly purpose: "owner-sign-in";
  readonly nonce: string;
  readonly verifier: string;
  readonly next: ReturnPath;
  readonly generation: Generation;
  readonly createdAt: number;
}
export class FlowProblem extends Data.TaggedError("FlowProblem") {}
const FlowSchema = Schema.Struct({
  purpose: Schema.Literal("owner-sign-in"),
  nonce: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  verifier: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43,128}$/)),
  next: Schema.String,
  generation: GenerationSchema,
  createdAt: Schema.Int,
});

export function beginFlow<F extends GoogleFlow>(flow: Omit<F, "createdAt">, now: number) {
  const state = randomToken();
  const value = base64url(new TextEncoder().encode(JSON.stringify({ ...flow, createdAt: now })));
  return { state, setCookie: hostCookie(`__Host-g-${state}`, value, 600) };
}

export const clearFlowCookie = (state: string) =>
  /^[A-Za-z0-9_-]+$/.test(state) ? hostCookie(`__Host-g-${state}`, "", 0) : undefined;

export function takeFlow(
  request: Request,
  state: string,
  now: number,
): Result.Result<GoogleFlow, FlowProblem> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(state)) return Result.fail(new FlowProblem());
    const raw = readCookie(request, `__Host-g-${state}`);
    if (!raw) return Result.fail(new FlowProblem());
    const decoded = Schema.decodeUnknownResult(FlowSchema)(JSON.parse(decodeBase64url(raw)));
    if (Result.isFailure(decoded)) return Result.fail(new FlowProblem());
    const flow = decoded.success;
    if (flow.createdAt > now || now - flow.createdAt > 600_000)
      return Result.fail(new FlowProblem());
    return Result.succeed({ ...flow, next: returnPath(flow.next, new URL(request.url).origin) });
  } catch {
    return Result.fail(new FlowProblem());
  }
}
