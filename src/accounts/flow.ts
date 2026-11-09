import { Schema } from "effect";
import { GenerationSchema, type Generation } from "../owner/owner";
import { parseAccountId, type AccountId } from "./model";
export type FlowStart = (
  | { purpose: "add" }
  | { purpose: "reconnect"; account: AccountId; version: number }
) & { generation: Generation; startedAt: number };
export type FlowState = FlowStart & { verifier: string };
const attributes = "HttpOnly; Secure; SameSite=Lax; Path=/";
const b64 = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const cookie = (request: Request, name: string) =>
  request.headers
    .get("Cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const encode = (value: unknown) => encodeURIComponent(JSON.stringify(value));
function decode(value: string | undefined): unknown {
  try {
    return value ? JSON.parse(decodeURIComponent(value)) : null;
  } catch {
    return null;
  }
}
const FlowSchema = Schema.Struct({
  purpose: Schema.Literals(["add", "reconnect"]),
  verifier: Schema.String.check(Schema.isPattern(/^[\w-]{43}$/)),
  generation: GenerationSchema,
  startedAt: Schema.Int,
  account: Schema.optional(Schema.String),
  version: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
// SHA-256 is asynchronous in WebCrypto; callers await the cookie and challenge together.
export async function beginFlow(start: FlowStart) {
  const state = b64(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  return {
    state,
    challenge,
    setCookie: `__Host-g-${state}=${encode({ ...start, verifier })}; ${attributes}; Max-Age=600`,
  };
}
export function takeFlow(
  request: Request,
  state: string,
  now: number,
): { flow: FlowState | null; clearCookie: string } {
  const safe = /^[\w-]{1,128}$/.test(state) ? state : "invalid";
  const name = `__Host-g-${safe}`;
  const clearCookie = `${name}=; ${attributes}; Max-Age=0`;
  const parsed = Schema.decodeUnknownOption(FlowSchema)(decode(cookie(request, name)));
  if (parsed._tag === "None" || safe !== state) return { flow: null, clearCookie };
  const value = parsed.value;
  if (value.startedAt > now || now - value.startedAt >= 600000) return { flow: null, clearCookie };
  if (value.purpose === "add")
    return {
      flow: {
        purpose: "add",
        verifier: value.verifier,
        generation: value.generation,
        startedAt: value.startedAt,
      },
      clearCookie,
    };
  const account = parseAccountId(value.account);
  return {
    flow:
      account && value.version
        ? {
            purpose: "reconnect",
            account,
            version: value.version,
            verifier: value.verifier,
            generation: value.generation,
            startedAt: value.startedAt,
          }
        : null,
    clearCookie,
  };
}
const AddressAlert = Schema.Struct({
  kind: Schema.Literals([
    "connected",
    "reconnected",
    "already_connected",
    "changed",
    "removed",
    "removed_unconfirmed",
  ]),
  address: Schema.String,
});
const SimpleAlert = Schema.Struct({
  kind: Schema.Literals([
    "didnt_finish",
    "google_down",
    "client_refused",
    "no_refresh_token",
    "unconfirmed",
  ]),
});
const AlertSchema = Schema.Union([
  AddressAlert,
  SimpleAlert,
  Schema.Struct({
    kind: Schema.Literal("address_taken"),
    address: Schema.String,
    name: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("wrong_account"),
    signedIn: Schema.String,
    target: Schema.String,
  }),
]);
export type AccountsAlert = typeof AlertSchema.Type;
export function setAlert(headers: Headers, alert: AccountsAlert) {
  headers.append(
    "Set-Cookie",
    `__Host-accounts-outcome=${encode(alert)}; ${attributes}; Max-Age=60`,
  );
}
export function takeAlert(request: Request, headers: Headers): AccountsAlert | null {
  const value = cookie(request, "__Host-accounts-outcome");
  if (!value) return null;
  headers.append("Set-Cookie", `__Host-accounts-outcome=; ${attributes}; Max-Age=0`);
  const parsed = Schema.decodeUnknownOption(AlertSchema)(decode(value));
  return parsed._tag === "Some" ? parsed.value : null;
}
