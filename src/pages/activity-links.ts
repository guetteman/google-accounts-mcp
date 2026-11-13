import type { ActivityQuery } from "../activity/store";

export function activityHref({ filter, before }: ActivityQuery): string {
  const params = new URLSearchParams();
  if (filter) params.set(filter.kind, filter.kind === "outcome" ? filter.outcome : filter.id);
  if (before !== null) params.set("before", String(before));
  return `/activity${params.size ? `?${params}` : ""}`;
}
