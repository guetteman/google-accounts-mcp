# google-accounts-mcp

This server lets one person's AI agents use several Google accounts at once: personal gmail.com accounts and Google Workspace accounts from any organization. The official connectors allow one account per client, and that is the gap we fill. Gmail comes first; other Google services follow, so do not design anything that only works for Gmail when it is as easy to keep it general.

Each deploy has one owner, who runs it on their own Cloudflare account with their own Google Cloud OAuth client. The repository is public so that anyone can deploy it, and a new owner must be able to deploy without editing code.

The server holds access to private mailboxes, so the owner's control comes before agent convenience. Each connection gets only the accounts and actions the owner granted, and every agent action is recorded in an audit log the owner can read. When two designs are both valid, choose the one that grants less by default and fails closed.

Reviewers apply `CODING_STANDARDS.md`; read it before you change code.

When you design or prototype a page, start from shadcn components and apply Refactoring UI (Wathan and Schoger) without inventing UI outside shadcn: build hierarchy with size, weight, and color before borders; de-emphasize labels and secondary text so the data stands out; avoid boxes inside boxes and keep a border only on what needs attention; give each screen one primary action; use generous, consistent spacing. Render it at 390 px and at desktop width and look at it before you show it.

- Write everything in this repository in English: code, docs, issues, pull requests, and product text. Issues live in this repository's GitHub tracker.
- The owner's Google accounts hold real mail. Call Google APIs against them only with the owner's permission, and never send, delete, or change mail in a real account without the owner's explicit approval for that action.
- Agents must never deploy.
- Keep `.gitignore` in place before you run `vp check --fix`; otherwise it can rewrite `node_modules` and corrupt the pnpm store.
- When you stop `pnpm dev`, stop its entire process group so that Vite and workerd do not keep running.

## Local development and verification

- Install dependencies with `vp install`. Run `vp check`, `pnpm exec wrangler types --check`, `vp test run`, and `vp build` before handing off a change. Tests include Worker tests in workerd and Node tests for the reset command, with a fake Google token endpoint.
- Run `vp dev` for page previews at `/__pages/:id`: `sign-in`, `sign-in-failed`, `sign-in-google-down`, `not-owner`, `mismatch`, `setup-incomplete`, `setup-incomplete-two`, `unavailable`, `accounts`, and `connections`. Previews pass through the owner gate, so they need a `.dev.vars` with the three settings (example values such as `OWNER_EMAIL=alex.personal@example.com` are enough) and the migration applied with `pnpm exec wrangler d1 migrations apply DB --local`. They exist only in development builds.
- Use `pnpm owner:reset --local` to reset local D1. The command defaults to remote D1 when `--local` is omitted. It reports the database, configuration, environment, stored owner, and generation before asking for confirmation. It takes the environment from `--env` or the `CLOUDFLARE_ENV` environment variable, not from `.env` files, and guards every statement on the database's `instance`, so a reset confirmed for one database changes nothing in another. Pass `--persist-to`, `--env`, or `--config` to select the same database as the local Worker.
- Until `wrangler.jsonc` has a `database_id`, local D1 state is keyed by the `DB` binding. Adding an ID switches to a different local database; apply migrations to that database before using it.
