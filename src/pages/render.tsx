import { renderToString } from "react-dom/server";
import { isFramePage, PRODUCT, type Page } from "./page";
import { frameElement } from "./registry";
import { SignInPage } from "./sign-in";
import { NotOwnerPage } from "./not-owner";
import { MismatchPage } from "./mismatch";
import { SetupIncompletePage } from "./setup-incomplete";
import { UnavailablePage } from "./unavailable";

const assets = import.meta.env.DEV
  ? { scripts: ["/@vite/client", "/src/pages/client.tsx"], styles: "/src/styles.css" }
  : { scripts: ["/assets/client.js"], styles: "/assets/styles.css" };

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'";

function pageElement(page: Page) {
  if (isFramePage(page)) return frameElement(page);
  switch (page._tag) {
    case "SignIn":
      return <SignInPage {...page} />;
    case "NotOwner":
      return <NotOwnerPage {...page} />;
    case "Mismatch":
      return <MismatchPage />;
    case "SetupIncomplete":
      return <SetupIncompletePage {...page} />;
    case "Unavailable":
      return <UnavailablePage />;
  }
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderPage(page: Page, init?: ResponseInit): Response {
  const hydrate = isFramePage(page);
  const body = renderToString(pageElement(page));
  const html = renderToString(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{PRODUCT}</title>
        <link rel="stylesheet" href={assets.styles} />
        {hydrate && assets.scripts.map((src) => <script key={src} type="module" src={src} />)}
      </head>
      <body>
        <div id="root" dangerouslySetInnerHTML={{ __html: body }} />
        {hydrate && (
          <script
            id="page-props"
            type="application/json"
            dangerouslySetInnerHTML={{ __html: jsonForScript(page) }}
          />
        )}
      </body>
    </html>,
  );
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", CSP);
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Cache-Control", "no-store");
  return new Response(`<!doctype html>${html}`, { ...init, headers });
}
