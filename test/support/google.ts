import { http, HttpResponse } from "msw";
import { b64url, unsignedAssertion } from "./oauth";
import { OWNER_EMAIL, testEnv } from "./worker";

export const MARKER = "PRIVATE_GOOGLE_TOKEN_";
export const SCOPES = ["gmail.readonly", "gmail.compose", "gmail.send", "gmail.modify"]
  .map((s) => `https://www.googleapis.com/auth/${s}`)
  .concat("https://mail.google.com/");
export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
export const LABELS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/labels";
// https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list
// Include documented visibility fields, which the tool must omit.
export const LABELS_RESPONSE = {
  labels: [
    {
      id: "INBOX",
      name: "INBOX",
      type: "system",
      messageListVisibility: "show",
      labelListVisibility: "labelShow",
    },
    {
      id: "Label_12",
      name: "Receipts",
      type: "user",
      messageListVisibility: "hide",
      labelListVisibility: "labelShowIfUnread",
    },
  ],
};
export const THREADS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
// Shapes observed on a real account on 2026-11-11 (issue #23), with made-up values. The list
// holds only IDs and snippets, snippets are HTML-escaped, and a thread's messages come oldest
// first with internalDate in milliseconds. Fields the tool must omit are included.
export const THREAD_LIST = {
  threads: [
    {
      id: "19a1b2c3d4e5f601",
      snippet: "Don&#39;t forget &quot;lunch&quot; &lt;today&gt; &amp; bring it",
      historyId: "12345678",
    },
    { id: "19a1b2c3d4e5f602", snippet: "Your receipt is attached", historyId: "12345679" },
  ],
  nextPageToken: "0a1b2c3d4e5f6a7b8c9d",
  resultSizeEstimate: 201,
};
const message = (id: string, at: string, from: string, subject: string, labelIds: string[]) => ({
  id,
  threadId: "ignored",
  labelIds,
  snippet: "ignored",
  payload: {
    mimeType: "text/html",
    headers: [
      { name: "From", value: from },
      { name: "Subject", value: subject },
    ],
  },
  sizeEstimate: 1024,
  historyId: "12345678",
  internalDate: at,
});
export const THREADS: Record<string, object> = {
  "19a1b2c3d4e5f601": {
    id: "19a1b2c3d4e5f601",
    historyId: "12345678",
    messages: [
      message("m1", "1794300000000", "Sam <sam@example.com>", "Lunch", ["INBOX"]),
      message("m2", "1794390096000", "Kim Lee <kim@example.com>", "Re: Lunch", ["UNREAD", "INBOX"]),
    ],
  },
  "19a1b2c3d4e5f602": {
    id: "19a1b2c3d4e5f602",
    historyId: "12345679",
    messages: [message("m3", "1794200000000", "billing@example.com", "Receipt", ["INBOX"])],
  },
};
export const THREAD_LINES = [
  {
    thread: "19a1b2c3d4e5f601",
    subject: "Lunch",
    from: "Kim Lee <kim@example.com>",
    date: "2026-11-11T09:41:36Z",
    snippet: `Don't forget "lunch" <today> & bring it`,
    messages: 2,
    unread: true,
  },
  {
    thread: "19a1b2c3d4e5f602",
    subject: "Receipt",
    from: "billing@example.com",
    date: "2026-11-09T04:53:20Z",
    snippet: "Your receipt is attached",
    messages: 1,
    unread: false,
  },
];
export const issuedTokens = new Set<string>();
export const token = () => {
  const value = `${MARKER}${crypto.randomUUID()}`;
  issuedTokens.add(value);
  return value;
};
export type Answer =
  | ((signal: AbortSignal) => Promise<Response>)
  | "ok"
  | "invalid_grant"
  | "admin_policy_enforced"
  | "invalid_client"
  | "slow"
  | 503
  | 429
  | { status: number; body: string; headers?: Record<string, string> };
export interface CodeOptions {
  claims?: Record<string, unknown>;
  scope?: string;
  noRefresh?: boolean;
  accessToken?: string;
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
  methods: [] as string[],
  attachmentRequests: [] as string[],
  attachmentAnswers: new Map<
    string,
    (request: Pick<Request, "signal">) => Response | Promise<Response>
  >(),
  draftRequests: [] as string[],
  draftAnswers: [] as Array<(request: Pick<Request, "signal">) => Response | Promise<Response>>,
  draftCreates: [] as Array<{
    url: string;
    method: string;
    redirect: RequestRedirect;
    contentType: string | null;
    body: unknown;
  }>,
  draftCreateAnswers: [] as Array<
    (request: Pick<Request, "signal">) => Response | Promise<Response>
  >,
  sends: [] as Array<{ url: string; body: { id: string }; redirect: RequestRedirect }>,
  sendAnswers: [] as Array<(request: Pick<Request, "signal">) => Response | Promise<Response>>,
  deletes: [] as string[],
  deleteAnswers: [] as Array<(request: Pick<Request, "signal">) => Response | Promise<Response>>,
  fullDraftRequests: [] as string[],
  fullDraftAnswers: new Map<
    string,
    (request: Pick<Request, "signal">) => Response | Promise<Response>
  >(),
  storedDrafts: new Map<string, object>(),
  uploads: [] as Array<{
    url: string;
    contentType: string;
    redirect: RequestRedirect;
    metadata: unknown;
    message: string;
  }>,
  uploadAnswers: [] as Array<(request: Pick<Request, "signal">) => Response | Promise<Response>>,
  messageRequests: [] as string[],
  messageAnswers: new Map<
    string,
    (request: Pick<Request, "signal">) => Response | Promise<Response>
  >(),
  labelRequests: [] as Array<{
    url: string;
    method: string;
    authorization: string | null;
    redirect: RequestRedirect;
  }>,
  labelAnswers: [] as Array<(request: Pick<Request, "signal">) => Response | Promise<Response>>,
  threadRequests: [] as Array<{
    url: string;
    authorization: string | null;
    redirect: RequestRedirect;
  }>,
  /** Answers for the list of threads, then the default list. */
  threadListAnswers: [] as Array<
    (request: Pick<Request, "signal">) => Response | Promise<Response>
  >,
  /** Answers for one thread by its ID, in place of the default thread. */
  threadAnswers: new Map<
    string,
    (request: Pick<Request, "signal">) => Response | Promise<Response>
  >(),
  codes: new Map<string, Code>(),
  exchangeAnswer: "ok" as Answer,
  refreshAnswers: [] as Answer[],
  revokeAnswer: "ok" as Answer,
  gmailAnswers: [] as (number | "lost")[],
  events: [] as string[],
  refreshTokens: [] as string[],
  tokenRedirects: [] as RequestRedirect[],
  revokeRedirects: [] as RequestRedirect[],
  revokedTokens: [] as string[],
  gmailTokens: [] as string[],
  issuedAccess: [] as string[],
  issuedRefresh: new Set<string>(),
  pending: [] as ReturnType<typeof deferred>[],
  reset() {
    this.release();
    this.codes.clear();
    this.methods = [];
    this.attachmentRequests = [];
    this.attachmentAnswers.clear();
    this.draftRequests = [];
    this.draftAnswers = [];
    this.draftCreates = [];
    this.draftCreateAnswers = [];
    this.sends = [];
    this.sendAnswers = [];
    this.deletes = [];
    this.deleteAnswers = [];
    this.fullDraftRequests = [];
    this.fullDraftAnswers.clear();
    this.storedDrafts.clear();
    this.uploads = [];
    this.uploadAnswers = [];
    this.messageRequests = [];
    this.messageAnswers.clear();
    this.labelRequests = [];
    this.labelAnswers = [];
    this.threadRequests = [];
    this.threadListAnswers = [];
    this.threadAnswers.clear();
    this.exchangeAnswer = "ok";
    this.revokeAnswer = "ok";
    this.refreshAnswers = [];
    this.gmailAnswers = [];
    this.events = [];
    this.refreshTokens = [];
    this.tokenRedirects = [];
    this.revokeRedirects = [];
    this.revokedTokens = [];
    this.gmailTokens = [];
    this.issuedAccess = [];
    this.issuedRefresh.clear();
    issuedTokens.clear();
  },
  release() {
    this.pending.forEach((p) => p.resolve());
    this.pending = [];
  },
  issueRefreshToken() {
    const value = token();
    this.issuedRefresh.add(value);
    return value;
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
  async answer(answer: Answer, signal: AbortSignal) {
    if (typeof answer === "function") return answer(signal);
    if (typeof answer === "object")
      return new HttpResponse(answer.body, { status: answer.status, headers: answer.headers });
    if (answer === "slow") {
      const pending = deferred();
      this.pending.push(pending);
      await pending.promise;
      return new HttpResponse(null, { status: 503 });
    }
    if (typeof answer === "number") return new HttpResponse(null, { status: answer });
    return answer === "ok"
      ? null
      : HttpResponse.json({ error: answer }, { status: answer === "invalid_client" ? 401 : 400 });
  },
  handlers() {
    return [
      http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
        this.tokenRedirects.push(request.redirect);
        const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
        if (
          form.get("client_id") !== testEnv().GOOGLE_CLIENT_ID ||
          form.get("client_secret") !== "fake"
        )
          return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
        if (form.get("grant_type") === "refresh_token") {
          this.events.push("refresh");
          this.refreshTokens.push(form.get("refresh_token")!);
          if (!this.issuedRefresh.has(form.get("refresh_token")!))
            return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
          const failure = await this.answer(this.refreshAnswers.shift() ?? "ok", request.signal);
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
        const failure = await this.answer(this.exchangeAnswer, request.signal);
        if (failure) return failure;
        const access = entry.accessToken ?? token();
        if (access) issuedTokens.add(access);
        this.issuedAccess.push(access);
        const idToken = unsignedAssertion({
          iss: "https://accounts.google.com",
          aud: testEnv().GOOGLE_CLIENT_ID,
          exp: Math.floor(Date.now() / 1000) + 3600,
          sub: "personal",
          email: OWNER_EMAIL,
          email_verified: true,
          test_marker: token(),
          ...entry.claims,
        });
        issuedTokens.add(idToken);
        return HttpResponse.json({
          access_token: access,
          ...(entry.noRefresh ? {} : { refresh_token: this.issueRefreshToken() }),
          expires_in: 3600,
          token_type: "Bearer",
          scope: entry.scope ?? ["openid", "email", ...SCOPES].join(" "),
          id_token: idToken,
        });
      }),
      http.post("https://oauth2.googleapis.com/revoke", async ({ request }) => {
        this.revokeRedirects.push(request.redirect);
        this.events.push("revoke");
        const revoked = new URLSearchParams(
          new TextDecoder().decode(await request.arrayBuffer()),
        ).get("token");
        if (!revoked || !this.issuedRefresh.has(revoked))
          return HttpResponse.json({ error: "invalid_token" }, { status: 400 });
        this.revokedTokens.push(revoked);
        return (
          (await this.answer(this.revokeAnswer, request.signal)) ??
          new HttpResponse(null, { status: 200 })
        );
      }),
      http.all(LABELS_URL, async ({ request }) => {
        this.methods.push(request.method);
        if (request.method !== "GET") return new HttpResponse(null, { status: 405 });
        this.labelRequests.push({
          url: request.url,
          method: request.method,
          authorization: request.headers.get("Authorization"),
          redirect: request.redirect,
        });
        return this.labelAnswers.shift()?.(request) ?? HttpResponse.json(LABELS_RESPONSE);
      }),
      http.all(THREADS_URL, async ({ request }) => {
        this.methods.push(request.method);
        if (request.method !== "GET") return new HttpResponse(null, { status: 405 });
        this.threadRequests.push({
          url: request.url,
          authorization: request.headers.get("Authorization"),
          redirect: request.redirect,
        });
        return (await this.threadListAnswers.shift()?.(request)) ?? HttpResponse.json(THREAD_LIST);
      }),
      http.all(`${THREADS_URL}/:id`, async ({ request, params }) => {
        this.methods.push(request.method);
        if (request.method !== "GET") return new HttpResponse(null, { status: 405 });
        this.threadRequests.push({
          url: request.url,
          authorization: request.headers.get("Authorization"),
          redirect: request.redirect,
        });
        const id = String(params.id);
        return (
          (await this.threadAnswers.get(id)?.(request)) ??
          (THREADS[id] ? HttpResponse.json(THREADS[id]) : new HttpResponse(null, { status: 404 }))
        );
      }),
      http.all(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/:message/attachments/:attachment",
        async ({ request, params }) => {
          this.methods.push(request.method);
          this.attachmentRequests.push(request.url);
          if (request.method !== "GET") return new HttpResponse(null, { status: 405 });
          return (
            (await this.attachmentAnswers.get(String(params.attachment))?.(request)) ??
            new HttpResponse(null, { status: 404 })
          );
        },
      ),
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
        async ({ request }) => {
          this.methods.push(request.method);
          const body = (await request.json()) as { id: string };
          this.sends.push({ url: request.url, body, redirect: request.redirect });
          const draft = this.storedDrafts.get(body.id) as { threadId?: string } | undefined;
          const response =
            (await this.sendAnswers.shift()?.(request)) ??
            (draft
              ? HttpResponse.json({
                  id: `sent-${this.sends.length}`,
                  threadId: draft.threadId ?? "sent-thread",
                })
              : new HttpResponse(null, { status: 404 }));
          if (response.ok) this.storedDrafts.delete(body.id);
          return response;
        },
      ),
      http.all(
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/:id",
        async ({ request, params }) => {
          this.methods.push(request.method);
          const id = String(params.id);
          if (request.method === "DELETE") {
            this.deletes.push(id);
            const response = await this.deleteAnswers.shift()?.(request);
            if (!response || response.ok) this.storedDrafts.delete(id);
            return response ?? new HttpResponse(null, { status: 204 });
          }
          this.fullDraftRequests.push(request.url);
          if (request.method !== "GET") return new HttpResponse(null, { status: 405 });
          return (
            (await this.fullDraftAnswers.get(id)?.(request)) ??
            (this.storedDrafts.has(id)
              ? HttpResponse.json({ id, message: this.storedDrafts.get(id) })
              : new HttpResponse(null, { status: 404 }))
          );
        },
      ),
      http.post(
        "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts",
        async ({ request }) => {
          this.methods.push(request.method);
          const contentType = request.headers.get("Content-Type") ?? "";
          const boundary = /boundary="?([^";]+)/.exec(contentType)?.[1];
          if (!boundary) return new HttpResponse(null, { status: 400 });
          const parts = new TextDecoder()
            .decode(await request.arrayBuffer())
            .split(`--${boundary}`);
          const content = (part: string) =>
            part.slice(part.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
          const metadata = JSON.parse(content(parts[1]!)) as { message?: { threadId?: string } };
          this.uploads.push({
            url: request.url,
            contentType,
            redirect: request.redirect,
            metadata,
            message: content(parts[2]!),
          });
          const n = this.draftCreates.length + this.uploads.length;
          const threadId = metadata.message?.threadId ?? `thread-${n}`;
          const response =
            (await this.uploadAnswers.shift()?.(request)) ??
            HttpResponse.json({ id: `draft-${n}`, message: { id: `message-${n}`, threadId } });
          if (response.ok) this.storedDrafts.set(`draft-${n}`, { threadId });
          return response;
        },
      ),
      http.all("https://gmail.googleapis.com/gmail/v1/users/me/drafts", async ({ request }) => {
        this.methods.push(request.method);
        if (request.method === "POST") {
          this.draftCreates.push({
            url: request.url,
            method: request.method,
            redirect: request.redirect,
            contentType: request.headers.get("Content-Type"),
            body: await request.json(),
          });
          const id = this.draftCreates.length;
          const response =
            (await this.draftCreateAnswers.shift()?.(request)) ??
            HttpResponse.json({
              id: `draft-${id}`,
              message: { id: `message-${id}`, threadId: `thread-${id}` },
            });
          if (response.ok) this.storedDrafts.set(`draft-${id}`, { threadId: `thread-${id}` });
          return response;
        }
        this.draftRequests.push(request.url);
        if (request.method !== "GET") return new HttpResponse(null, { status: 405 });
        return (await this.draftAnswers.shift()?.(request)) ?? HttpResponse.json({});
      }),
      http.all(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/:id",
        async ({ request, params }) => {
          this.methods.push(request.method);
          this.messageRequests.push(request.url);
          if (request.method !== "GET") return new HttpResponse(null, { status: 405 });
          return (
            (await this.messageAnswers.get(String(params.id))?.(request)) ??
            new HttpResponse(null, { status: 404 })
          );
        },
      ),
      http.get(GMAIL, ({ request }) => {
        this.methods.push(request.method);
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
