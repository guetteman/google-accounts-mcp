import { expect } from "vite-plus/test";
import { google, GOOGLE_AUTHORIZE, type Claims } from "./google";
import { callWorker, formsOf, location, ORIGIN, testEnv } from "./worker";

export interface SetCookie {
  readonly name: string;
  readonly value: string;
  readonly attributes: Record<string, string | true>;
  readonly raw: string;
}

export function parseSetCookie(raw: string): SetCookie {
  const [pair = "", ...parts] = raw.split(";");
  const eq = pair.indexOf("=");
  const attributes: Record<string, string | true> = {};
  for (const part of parts) {
    const [key = "", ...rest] = part.trim().split("=");
    const name = key.toLowerCase();
    const value = rest.join("=");
    // SameSite values are case-insensitive; compare them in lower case.
    attributes[name] = rest.length ? (name === "samesite" ? value.toLowerCase() : value) : true;
  }
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attributes, raw };
}

export function setCookies(response: Response): SetCookie[] {
  return response.headers.getSetCookie().map(parseSetCookie);
}

/** True when a Set-Cookie tells the browser to drop the cookie. */
export function clears(cookie: SetCookie): boolean {
  const maxAge = cookie.attributes["max-age"];
  if (typeof maxAge === "string" && Number(maxAge) <= 0) return true;
  const expires = cookie.attributes["expires"];
  return typeof expires === "string" && Date.parse(expires) <= Date.now();
}

export interface SignInStart {
  readonly response: Response;
  readonly authorizationUrl: URL;
  readonly state: string;
  readonly nonce: string;
}

interface RequestOptions {
  readonly method?: string;
  readonly form?: Record<string, string>;
  readonly headers?: Record<string, string>;
  /** The Origin header for requests other than GET and HEAD; `null` sends none. */
  readonly origin?: string | null;
  readonly env?: Env;
}

/**
 * A browser on the owner's side: it keeps cookies the Worker sets (dropping those a
 * Set-Cookie clears, keeping others regardless of age, as a replaying client would), sends
 * them back, and sends this deploy's Origin on form posts, as Chrome and Safari do.
 */
export class Browser {
  readonly cookies = new Map<string, string>();

  constructor(private readonly defaultEnv: () => Env = () => testEnv()) {}

  async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const method = options.method ?? (options.form ? "POST" : "GET");
    const headers = new Headers(options.headers);
    if (this.cookies.size > 0 && !headers.has("Cookie")) {
      headers.set(
        "Cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (method !== "GET" && method !== "HEAD" && origin !== null) headers.set("Origin", origin);
    let body: string | undefined;
    if (options.form) {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(options.form).toString();
    }
    const response = await callWorker(
      new Request(new URL(path, ORIGIN), { method, headers, body, redirect: "manual" }),
      options.env ?? this.defaultEnv(),
    );
    this.keep(response);
    return response;
  }

  get(path: string, options: Omit<RequestOptions, "method" | "form"> = {}): Promise<Response> {
    return this.request(path, { ...options, method: "GET" });
  }

  post(
    path: string,
    form: Record<string, string> = {},
    options: Omit<RequestOptions, "method" | "form"> = {},
  ) {
    return this.request(path, { ...options, method: "POST", form });
  }

  keep(response: Response): void {
    for (const cookie of setCookies(response)) {
      if (clears(cookie)) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
  }

  get session(): string | undefined {
    return this.cookies.get("__Host-session");
  }

  /** Posts the sign-in form and reads what Google would receive from the redirect. */
  async startSignIn(next?: string, options: { env?: Env } = {}): Promise<SignInStart> {
    const response = await this.post("/signin", next === undefined ? {} : { next }, options);
    expect(response.status, "POST /signin redirects to Google").toBe(302);
    const target = location(response) ?? "";
    expect(target.startsWith(GOOGLE_AUTHORIZE), `redirect to Google, got ${target}`).toBe(true);
    const authorizationUrl = new URL(target);
    return {
      response,
      authorizationUrl,
      state: authorizationUrl.searchParams.get("state") ?? "",
      nonce: authorizationUrl.searchParams.get("nonce") ?? "",
    };
  }

  /** Google sends the browser back with a code for an account whose ID token holds `claims`. */
  async finishSignIn(
    start: SignInStart,
    claims: Claims = {},
    options: { env?: Env } = {},
  ): Promise<Response> {
    const code = google.authorize(start.authorizationUrl, claims);
    return this.callback({ code, state: start.state }, options);
  }

  callback(params: Record<string, string>, options: { env?: Env } = {}): Promise<Response> {
    return this.get(`/google/callback?${new URLSearchParams(params).toString()}`, options);
  }

  /** Signs in through the whole flow as the Google account `claims` describe (the owner by default). */
  async signIn(claims: Claims = {}, next?: string): Promise<Response> {
    return this.finishSignIn(await this.startSignIn(next), claims);
  }

  async signInAsOwner(claims: Claims = {}): Promise<void> {
    const response = await this.signIn(claims);
    expect(response.status, "the owner's sign-in redirects onward").toBe(302);
    expect(this.session, "the owner gets a session cookie").toBeDefined();
    // This method prepares a signed-in fixture. Measure Google calls made by the tested action.
    google.tokenRequests.length = 0;
  }

  /** Submits the page's form whose action is `action`, with its own fields. */
  async submit(html: string, action: string, options: { env?: Env } = {}): Promise<Response> {
    const form = formsOf(html).find((f) => f.action === action);
    expect(form, `a form posting to ${action}`).toBeDefined();
    expect(form?.method).toBe("post");
    return this.post(action, form?.fields ?? {}, options);
  }
}
