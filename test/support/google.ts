import { http, HttpResponse } from "msw";
import { b64url, unsignedAssertion } from "./oauth";
import { OWNER_EMAIL, testEnv } from "./worker";

export const MARKER = "PRIVATE_GOOGLE_TOKEN_";
export const SCOPES = ["gmail.readonly", "gmail.compose", "gmail.send", "gmail.modify"]
  .map((s) => `https://www.googleapis.com/auth/${s}`)
  .concat("https://mail.google.com/");
export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
export const token = () => `${MARKER}${crypto.randomUUID()}`;
export type Answer =
  | "ok"
  | "invalid_grant"
  | "admin_policy_enforced"
  | "invalid_client"
  | "slow"
  | 503
  | 429;
export interface CodeOptions {
  claims?: Record<string, unknown>;
  scope?: string;
  noRefresh?: boolean;
}
interface Code extends CodeOptions {
  state: string;
  challenge: string;
  redirectUri: string;
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export const google = {
  codes: new Map<string, Code>(),
  exchangeAnswer: "ok" as Answer,
  refreshAnswers: [] as Answer[],
  revokeAnswer: "ok" as Answer,
  gmailAnswers: [] as (number | "lost")[],
  events: [] as string[],
  refreshTokens: [] as string[],
  gmailTokens: [] as string[],
  issuedAccess: [] as string[],
  pending: [] as ReturnType<typeof deferred>[],
  reset() {
    this.release();
    this.codes.clear();
    this.exchangeAnswer = "ok";
    this.revokeAnswer = "ok";
    this.refreshAnswers = [];
    this.gmailAnswers = [];
    this.events = [];
    this.refreshTokens = [];
    this.gmailTokens = [];
    this.issuedAccess = [];
  },
  release() {
    this.pending.forEach((p) => p.resolve());
    this.pending = [];
  },
  issueCode(url: URL, options: CodeOptions = {}) {
    const code = crypto.randomUUID();
    this.codes.set(code, {
      state: url.searchParams.get("state")!,
      challenge: url.searchParams.get("code_challenge")!,
      redirectUri: url.searchParams.get("redirect_uri")!,
      ...options,
    });
    return `/google/callback?${new URLSearchParams({ code, state: url.searchParams.get("state")! })}`;
  },
  async answer(answer: Answer) {
    if (answer === "slow") {
      const pending = deferred();
      this.pending.push(pending);
      await pending.promise;
      return new HttpResponse(null, { status: 503 });
    }
    if (typeof answer === "number") return new HttpResponse(null, { status: answer });
    return answer === "ok" ? null : HttpResponse.json({ error: answer }, { status: 400 });
  },
  handlers() {
    return [
      http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
        const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
        if (
          form.get("client_id") !== testEnv().GOOGLE_CLIENT_ID ||
          form.get("client_secret") !== "fake"
        )
          return HttpResponse.json({ error: "invalid_client" }, { status: 400 });
        if (form.get("grant_type") === "refresh_token") {
          this.events.push("refresh");
          this.refreshTokens.push(form.get("refresh_token")!);
          const failure = await this.answer(this.refreshAnswers.shift() ?? "ok");
          if (failure) return failure;
          const access = token();
          this.issuedAccess.push(access);
          return HttpResponse.json({
            access_token: access,
            expires_in: 3600,
            token_type: "Bearer",
          });
        }
        this.events.push("exchange");
        const code = form.get("code")!;
        const entry = this.codes.get(code);
        this.codes.delete(code);
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(form.get("code_verifier") ?? ""),
        );
        if (
          !entry ||
          entry.challenge !== b64url(new Uint8Array(digest)) ||
          entry.redirectUri !== form.get("redirect_uri")
        )
          return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
        const failure = await this.answer(this.exchangeAnswer);
        if (failure) return failure;
        const access = token();
        this.issuedAccess.push(access);
        return HttpResponse.json({
          access_token: access,
          ...(entry.noRefresh ? {} : { refresh_token: token() }),
          expires_in: 3600,
          token_type: "Bearer",
          scope: entry.scope ?? ["openid", "email", ...SCOPES].join(" "),
          id_token: unsignedAssertion({
            iss: "https://accounts.google.com",
            aud: testEnv().GOOGLE_CLIENT_ID,
            exp: Math.floor(Date.now() / 1000) + 3600,
            sub: "personal",
            email: OWNER_EMAIL,
            email_verified: true,
            test_marker: token(),
            ...entry.claims,
          }),
        });
      }),
      http.post("https://oauth2.googleapis.com/revoke", async ({ request }) => {
        this.events.push("revoke");
        if (
          !new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()))
            .get("token")
            ?.includes(MARKER)
        )
          throw new Error("Revoke needs a plaintext test token");
        return (await this.answer(this.revokeAnswer)) ?? new HttpResponse(null, { status: 200 });
      }),
      http.get(GMAIL, ({ request }) => {
        this.events.push("gmail");
        this.gmailTokens.push(request.headers.get("Authorization")!);
        const answer = this.gmailAnswers.shift() ?? 200;
        return answer === "lost"
          ? HttpResponse.error()
          : HttpResponse.json({ emailAddress: OWNER_EMAIL }, { status: answer });
      }),
    ];
  },
};
