import { HOST } from "./worker";

// The page copy accepted in #8 and its "Building #8" comment.
export const SIGN_IN = {
  title: `Sign in to manage ${HOST}`,
  line: "Only this server's owner can sign in.",
  button: "Sign in with Google",
};
export const NOT_OWNER = {
  title: "This server belongs to someone else",
  line: (address: string) =>
    `You signed in to Google as ${address}, which doesn't own this server. Nothing changed.`,
  unnamed: "You signed in to Google with an account that doesn't own this server",
  button: "Use a different Google account",
};
export const DIDNT_FINISH = {
  title: "Sign-in didn't finish",
  line: "It expired, was cancelled, or started in another browser. Nothing changed. Sign in again.",
};
export const GOOGLE_DOWN = {
  title: "Google didn't answer",
  line: "Nothing changed. Try again in a minute.",
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
