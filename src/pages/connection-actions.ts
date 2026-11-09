import type { Outcome } from "../connections/model";

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
export async function postConnectionAction(
  url: string,
  fields: Record<string, string> = {},
  send: typeof fetch = fetch,
): Promise<Outcome> {
  try {
    const response = await send(url, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { Accept: "application/json" },
    });
    if (!response.headers.get("Content-Type")?.includes("application/json"))
      return response.status === 503 ? "unavailable" : "unknown";
    const value: unknown = await response.json();
    if (
      value &&
      typeof value === "object" &&
      "outcome" in value &&
      ["ok", "already_ended", "not_found", "invalid", "unavailable", "unknown"].includes(
        String(value.outcome),
      )
    )
      return value.outcome as Outcome;
    return "unknown";
  } catch {
    return "unknown";
  }
}
