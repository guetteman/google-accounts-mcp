import { signAccessJwt, type Claims } from "./access";
import { callWorker, ORIGIN, testEnv } from "./worker";

export interface RequestOptions {
  readonly method?: string;
  readonly form?: Record<string, string> | [string, string][];
  readonly headers?: Record<string, string>;
  readonly origin?: string | null;
  readonly env?: Env;
}

/** A browser behind fake Access, with host-only cookies kept separately for each origin. */
export class Browser {
  assertion?: string;
  private readonly cookieExpiries = new Map<string, number>();
  readonly cookies = new Map<string, Map<string, string>>();
  constructor(private readonly defaultEnv: () => Env = () => testEnv()) {}

  async authenticate(claims: Claims = {}): Promise<void> {
    this.assertion = await signAccessJwt(claims);
  }

  async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(path, ORIGIN);
    const method = options.method ?? (options.form ? "POST" : "GET");
    const headers = new Headers(options.headers);
    if (this.assertion && !headers.has("Cf-Access-Jwt-Assertion"))
      headers.set("Cf-Access-Jwt-Assertion", this.assertion);
    if (!headers.has("Cookie")) {
      const jar = this.cookies.get(url.origin);
      if (jar)
        for (const name of jar.keys()) {
          const expiry = this.cookieExpiries.get(`${url.origin}|${name}`);
          if (expiry !== undefined && expiry <= Date.now()) jar.delete(name);
        }
      if (jar?.size) headers.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const origin = options.origin === undefined ? url.origin : options.origin;
    if (method !== "GET" && method !== "HEAD" && origin !== null) headers.set("Origin", origin);
    let body: string | undefined;
    if (options.form) {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(options.form).toString();
    }
    const response = await callWorker(
      new Request(url, { method, headers, body, redirect: "manual" }),
      options.env ?? this.defaultEnv(),
    );
    const jar = this.cookies.get(url.origin) ?? new Map<string, string>();
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0] ?? "";
      const equals = pair.indexOf("=");
      const name = pair.slice(0, equals);
      const value = pair.slice(equals + 1);
      if (/Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name);
      else {
        jar.set(name, value);
        const maxAge = /Max-Age=(\d+)(?:;|$)/i.exec(cookie)?.[1];
        if (maxAge !== undefined)
          this.cookieExpiries.set(`${url.origin}|${name}`, Date.now() + Number(maxAge) * 1000);
      }
    }
    this.cookies.set(url.origin, jar);
    return response;
  }
  get(path: string, options: Omit<RequestOptions, "method" | "form"> = {}) {
    return this.request(path, { ...options, method: "GET" });
  }
  post(
    path: string,
    form: Record<string, string> | [string, string][] = {},
    options: Omit<RequestOptions, "method" | "form"> = {},
  ) {
    return this.request(path, { ...options, method: "POST", form });
  }
}
