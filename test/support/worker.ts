import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";

export const observedBodies: unknown[] = [];
export const HOST = "accounts-mcp.example.com";
export const ORIGIN = `https://${HOST}`;
export const OWNER_EMAIL = "alex.personal@example.com";

let issuer = "https://example-team.cloudflareaccess.com";
export function freshAccessIssuer(): void {
  issuer = `https://test-${crypto.randomUUID()}.cloudflareaccess.com`;
}

/**
 * The environment the Worker's fetch receives. Tests change it between requests (a new
 * OWNER_EMAIL, a missing secret, a broken DB) without touching the shared bindings.
 * A value of `undefined` removes the setting, as if it were never set.
 */
export function testEnv(overrides: { [K in keyof Env]?: Env[K] | undefined } = {}): Env {
  const base: Record<string, unknown> = {
    DB: env.DB,
    OAUTH_KV: env.OAUTH_KV,
    FILES_KV: env.FILES_KV,
    OWNER_EMAIL: env.OWNER_EMAIL,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "a".repeat(64),
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fake",
    TOKEN_KEY: "b".repeat(64),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base as unknown as Env;
}

/** Calls the Worker module's default export, as Cloudflare would. */
export async function callWorker(request: Request, workerEnv: Env = testEnv()): Promise<Response> {
  const ctx = createExecutionContext();
  const { default: worker } = await import("../../src/index");
  const response = await worker.fetch(request, workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  if (new URL(request.url).pathname.match(/^\/(accounts|google)(\/|$)/))
    observedBodies.push({
      body: await response.clone().text(),
      headers: [...response.headers],
      cookies: response.headers.getSetCookie(),
    });
  return response;
}

/** The redirect target as a path when it stays on this deploy, otherwise the full URL. */
export function location(response: Response): string | null {
  const raw = response.headers.get("Location");
  if (raw === null) return null;
  const url = new URL(raw, ORIGIN);
  return url.origin === ORIGIN ? `${url.pathname}${url.search}` : url.href;
}

/** The visible text of an HTML page: no tags, no comments, entities decoded, spaces collapsed. */
export function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, "")
      // Inline formatting does not add visible whitespace around punctuation.
      .replace(/<\/?(?:span|strong|em|code)\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export interface HtmlForm {
  readonly action: string;
  readonly method: string;
  readonly fields: Record<string, string>;
  readonly buttons: string[];
}

/** Every <form> on the page with its action, method, hidden and named inputs, and button labels. */
export function formsOf(html: string): HtmlForm[] {
  const forms: HtmlForm[] = [];
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const fields: Record<string, string> = {};
    for (const input of body.matchAll(/<input\b([^>]*)>/gi)) {
      const name = attr(input[1] ?? "", "name");
      if (name !== null) fields[name] = attr(input[1] ?? "", "value") ?? "";
    }
    const buttons = [...body.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map((b) =>
      textOf(b[1] ?? ""),
    );
    forms.push({
      action: attr(attrs, "action") ?? "",
      method: (attr(attrs, "method") ?? "get").toLowerCase(),
      fields,
      buttons,
    });
  }
  return forms;
}

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs);
  return match ? decodeEntities(match[1] ?? "") : null;
}
