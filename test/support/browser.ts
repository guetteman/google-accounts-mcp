import { signAccessJwt, type Claims } from "./access";
import { callWorker, ORIGIN, testEnv } from "./worker";

interface RequestOptions {
  readonly method?: string;
  readonly form?: Record<string, string>;
  readonly headers?: Record<string, string>;
  readonly origin?: string | null;
  readonly env?: Env;
}

/** A browser behind fake Access. The Worker never creates cookies or sessions. */
export class Browser {
  assertion?: string;
  constructor(private readonly defaultEnv: () => Env = () => testEnv()) {}

  async authenticate(claims: Claims = {}): Promise<void> {
    this.assertion = await signAccessJwt(claims);
  }

  async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const method = options.method ?? (options.form ? "POST" : "GET");
    const headers = new Headers(options.headers);
    if (this.assertion && !headers.has("Cf-Access-Jwt-Assertion"))
      headers.set("Cf-Access-Jwt-Assertion", this.assertion);
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (method !== "GET" && method !== "HEAD" && origin !== null) headers.set("Origin", origin);
    let body: string | undefined;
    if (options.form) {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(options.form).toString();
    }
    return callWorker(
      new Request(new URL(path, ORIGIN), { method, headers, body, redirect: "manual" }),
      options.env ?? this.defaultEnv(),
    );
  }
  get(path: string, options: Omit<RequestOptions, "method" | "form"> = {}) {
    return this.request(path, { ...options, method: "GET" });
  }
  post(
    path: string,
    form: Record<string, string> = {},
    options: Omit<RequestOptions, "method" | "form"> = {},
  ) {
    return this.request(path, { ...options, method: "POST", form });
  }
}
