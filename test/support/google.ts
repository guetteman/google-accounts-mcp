import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { network } from "./network";

export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

/** ID token claims. A claim set to `undefined` is left out of the token. */
export type Claims = Record<string, unknown>;

interface IssuedCode {
  readonly claims: Claims;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  used: boolean;
}

export type GoogleMode = "ok" | "slow" | "5xx" | "429";

/**
 * A stand-in for Google's token endpoint. Codes come from `authorize`, which plays Google's
 * consent page for the authorization URL the Worker redirected to. A code works once; a
 * reused code, a wrong client, a wrong redirect URI, or a wrong PKCE verifier get
 * `400 invalid_grant`, as Google answers.
 */
class FakeGoogle {
  mode: GoogleMode = "ok";
  readonly tokenRequests: URLSearchParams[] = [];
  private readonly codes = new Map<string, IssuedCode>();
  private releaseSlow: Array<() => void> = [];

  reset(): void {
    this.mode = "ok";
    this.tokenRequests.length = 0;
    this.codes.clear();
    this.release();
  }

  /** Lets every request held by the "slow" mode finish. */
  release(): void {
    for (const release of this.releaseSlow) release();
    this.releaseSlow = [];
  }

  /** Google's consent page: the user picked an account whose ID token holds `claims`. */
  authorize(authorizationUrl: URL, claims: Claims = {}): string {
    const params = authorizationUrl.searchParams;
    const now = Math.floor(Date.now() / 1000);
    const defaults: Claims = {
      iss: "https://accounts.google.com",
      aud: params.get("client_id"),
      azp: params.get("client_id"),
      sub: "sub-a",
      email: env.OWNER_EMAIL,
      email_verified: true,
      nonce: params.get("nonce"),
      iat: now,
      exp: now + 3600,
    };
    const code = `code-${crypto.randomUUID()}`;
    this.codes.set(code, {
      claims: { ...defaults, ...claims },
      clientId: params.get("client_id") ?? "",
      redirectUri: params.get("redirect_uri") ?? "",
      challenge: params.get("code_challenge") ?? "",
      used: false,
    });
    return code;
  }

  handlers() {
    return [
      http.post(GOOGLE_TOKEN, async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        this.tokenRequests.push(form);
        if (this.mode === "slow") {
          await new Promise<void>((resolve) => this.releaseSlow.push(resolve));
          return HttpResponse.json({ error: "too_late" }, { status: 500 });
        }
        if (this.mode === "5xx")
          return HttpResponse.json({ error: "internal_failure" }, { status: 503 });
        if (this.mode === "429")
          return HttpResponse.json({ error: "rate_limit_exceeded" }, { status: 429 });
        const issued = this.codes.get(form.get("code") ?? "");
        const verifierMatches =
          issued !== undefined &&
          (await s256(form.get("code_verifier") ?? "")) === issued.challenge;
        if (
          issued === undefined ||
          issued.used ||
          form.get("grant_type") !== "authorization_code" ||
          form.get("client_id") !== issued.clientId ||
          form.get("client_secret") !== env.GOOGLE_CLIENT_SECRET ||
          form.get("redirect_uri") !== issued.redirectUri ||
          !verifierMatches
        ) {
          if (issued) issued.used = true;
          return HttpResponse.json(
            { error: "invalid_grant", error_description: "Bad Request" },
            { status: 400 },
          );
        }
        issued.used = true;
        return HttpResponse.json({
          access_token: `ya29.${crypto.randomUUID()}`,
          expires_in: 3599,
          scope: "openid https://www.googleapis.com/auth/userinfo.email",
          token_type: "Bearer",
          id_token: idToken(issued.claims),
        });
      }),
    ];
  }
}

export const google = new FakeGoogle();

export function useGoogleFake(): void {
  google.reset();
  network.use(...google.handlers());
}

/** An unsigned-looking JWT: header.payload.signature, the payload holding `claims`. */
export function idToken(claims: Claims): string {
  const present = Object.fromEntries(
    Object.entries(claims).filter(([, value]) => value !== undefined),
  );
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "test", typ: "JWT" }));
  return `${header}.${base64url(JSON.stringify(present))}.${base64url("signature")}`;
}

export function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromBase64url(value: string): string {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
