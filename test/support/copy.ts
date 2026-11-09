export const ACCESS_REFUSED = {
  title: "Open this server through Cloudflare Access",
  line: "This address isn't protected by the server's Cloudflare Access application, so it can't tell who you are. Nothing changed. Open the server from the address its Access application covers.",
};
export const ACCESS_UNAVAILABLE = {
  title: "Cloudflare Access didn't answer",
  line: "Nothing changed. Reload this page in a minute.",
};
export const NOT_OWNER = {
  title: "This server belongs to someone else",
  button: "Use a different account",
};
export const SETUP_INCOMPLETE = { title: "This server isn't set up yet" };
export const UNAVAILABLE = {
  title: "The server can't reach its database",
  line: "Nothing changed. Reload this page in a minute.",
};
export const MISMATCH = {
  title: "This server's owner setting changed",
  command: "pnpm owner:reset",
};
export const PRODUCT = "Google Accounts MCP";
