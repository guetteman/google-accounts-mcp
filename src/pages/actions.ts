export type Outcome = "ok" | "already_ended" | "not_found" | "invalid" | "unavailable" | "unknown";
export interface ActionResult {
  readonly outcome: Outcome;
  readonly url?: string;
}
export async function postAction(
  url: string,
  fields: Record<string, string> = {},
  send: typeof fetch = fetch,
): Promise<ActionResult> {
  try {
    const response = await send(url, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { Accept: "application/json" },
    });
    if (!response.headers.get("Content-Type")?.includes("application/json"))
      return { outcome: response.status === 503 ? "unavailable" : "unknown" };
    const value: unknown = await response.json();
    if (
      value &&
      typeof value === "object" &&
      "outcome" in value &&
      ["ok", "already_ended", "not_found", "invalid", "unavailable", "unknown"].includes(
        String(value.outcome),
      )
    )
      return {
        outcome: value.outcome as Outcome,
        ...("url" in value && typeof value.url === "string" ? { url: value.url } : {}),
      };
    return { outcome: "unknown" };
  } catch {
    return { outcome: "unknown" };
  }
}
