# google-accounts-mcp

This server lets one person's AI agents use several Google accounts at once: personal gmail.com accounts and Google Workspace accounts from any organization. The official connectors allow one account per client, and this server removes that limit. Gmail comes first and other Google services follow, so keep a design general whenever that costs no more than a Gmail-only one.

Each deploy has one owner, who runs it on their own Cloudflare account with their own Google Cloud OAuth client. The repository is public so that anyone can deploy it, and a new owner must be able to deploy without editing code. Deploys require the Workers Paid plan, so size limits to that plan's limits.

The server holds access to private mailboxes, so the owner's control comes before agent convenience. Each connection gets only the accounts and actions the owner granted, and the server records every agent action in an audit log the owner can read. When two designs are both valid, choose the one that grants less by default and fails closed.

Reviewers apply `CODING_STANDARDS.md`; read it before you change code.

The project is in development, and the owner's deploy is its only deploy. Add compatibility with earlier versions, rollback paths, or guards for several deploys only when the owner asks for them.

When you design or prototype a page, start from shadcn components and apply Refactoring UI (Wathan and Schoger) without inventing UI outside shadcn. Build hierarchy with size, weight, and color before borders. Make labels and secondary text quieter than the data. Do not put boxes inside boxes, and keep a border only on what needs attention. Give each screen one primary action, and keep spacing generous and consistent. Look at the page at 390 px and at desktop width before you show it.

- Write everything in this repository in English: code, docs, issues, pull requests, and product text. Issues live in this repository's GitHub tracker.
- The owner's Google accounts hold real mail. Call Google APIs against them only with the owner's permission, and never send, delete, or change mail in a real account without the owner's explicit approval for that action.
- Deploy only when the owner asks for it in the conversation.
- Keep `.gitignore` in place before you run `vp check --fix`; otherwise it can rewrite `node_modules` and corrupt the pnpm store.
- When you stop `pnpm dev`, stop its entire process group so that Vite and workerd do not keep running.

## Local development and verification

- Install dependencies with `vp install`, and run `pnpm exec playwright-core install chromium` once before the first `vp test run`. Run `vp check`, `pnpm exec wrangler types --check`, `vp test run`, and `vp build` before handing off a change. Worker tests run in workerd (`test/*.test.ts`). Tests in `test/repo/` run in Node and cover the reset command and the page dialogs in Chromium.
- Run `vp dev` for page previews at `/__pages/:id`. Each id and its sample data are in `src/pages/previews.ts`; previews exist only in development builds. Previews pass through the owner gate, so they need a `.dev.vars` with the six settings (`OWNER_EMAIL=alex.personal@example.com`, `ACCESS_ISSUER=https://example-team.cloudflareaccess.com`, a 64-hex `ACCESS_AUDIENCE`, `GOOGLE_CLIENT_ID=test-client.apps.googleusercontent.com`, `GOOGLE_CLIENT_SECRET=fake`, and a 64-hex `TOKEN_KEY` are enough) and the migrations applied with `pnpm exec wrangler d1 migrations apply DB --local`. A real local Google flow requires `http://localhost:<port>/google/callback` registered on its OAuth client. Local OAuth flows work over plain HTTP only on loopback hosts such as `localhost`; reviewing OAuth over Tailscale needs HTTPS, for example `tailscale serve`. Page previews still work over plain HTTP on Tailscale.
- Use `pnpm owner:reset --local` to reset local D1. The command defaults to remote D1 when `--local` is omitted. It reports the database, configuration, stored owner, and generation before asking for confirmation. Pass `--persist-to` or `--config` to select the same database as the local Worker.
- Until `wrangler.jsonc` has a `database_id`, local D1 state is keyed by the `DB` binding. Adding an ID switches to a different local database; apply migrations to that database before using it.

## Tools

Each MCP tool's contract (its input, limits, and the description agents read) lives in its definition in `src/mcp/tools.ts`.
