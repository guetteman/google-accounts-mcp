import type { Outcome } from "./actions";

export function outcomeMessage(outcome: Outcome, name: string): string | null {
  switch (outcome) {
    case "ok":
      return null;
    case "already_ended":
      return `${name} already ended. Nothing changed.`;
    case "not_found":
      return "This connection no longer exists. Nothing changed. Reload the page.";
    case "invalid":
      return "Use a connection name with 1 to 100 characters.";
    case "unavailable":
      return "Couldn't reach the database. Nothing changed. Try again in a minute.";
    case "unknown":
      return "Couldn't confirm the change. Reload the page to see whether it happened.";
  }
}

export function permissionMessage(outcome: Outcome, name: string): string | null {
  if (outcome === "not_found")
    return "This connection or account no longer exists. Nothing changed. Reload the page.";
  if (outcome === "invalid") return "Nothing changed. Reload the page.";
  return outcomeMessage(outcome, name);
}
