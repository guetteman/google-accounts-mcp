import type { Generation } from "../owner/owner";
import { GenerationSchema } from "../owner/owner";
import { Schema } from "effect";

export type ConnectionId = string & { readonly __connectionId: unique symbol };
import { parseName, type Name } from "../names";
export type App = "claude-hosted" | "claude-code" | "chatgpt";
export const APP_LABELS = {
  "claude-hosted": "Claude",
  "claude-code": "Claude Code",
  chatgpt: "ChatGPT",
} as const;
export const parseConnectionId = (raw: unknown): ConnectionId | null =>
  typeof raw === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)
    ? (raw as ConnectionId)
    : null;
export const newConnectionId = (): ConnectionId => crypto.randomUUID() as ConnectionId;
export interface GrantProps {
  readonly v: 1;
  readonly connectionId: ConnectionId;
}
export interface PendingGrant extends GrantProps {
  readonly name: Name;
  readonly generation: Generation;
}
export function decodeGrantProps(raw: unknown): GrantProps | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("v" in raw) ||
    raw.v !== 1 ||
    !("connectionId" in raw)
  )
    return null;
  const connectionId = parseConnectionId(raw.connectionId);
  return connectionId ? { v: 1, connectionId } : null;
}
export function decodePendingGrant(raw: unknown): PendingGrant | null {
  const props = decodeGrantProps(raw);
  if (
    !props ||
    typeof raw !== "object" ||
    raw === null ||
    !("name" in raw) ||
    !("generation" in raw)
  )
    return null;
  const name = parseName(raw.name);
  const generation = Schema.decodeUnknownOption(GenerationSchema)(raw.generation);
  return name && generation._tag === "Some"
    ? { ...props, name, generation: generation.value }
    : null;
}
export interface ActiveConnection {
  readonly connectionId: ConnectionId;
  readonly app: App;
}
export interface ConnectionView {
  readonly canSee: ReadonlyArray<string>;
  readonly id: ConnectionId;
  readonly name: string;
  readonly appLabel: string;
  readonly status:
    | { readonly kind: "active" }
    | { readonly kind: "revoked" | "expired"; readonly on: string };
  readonly lastUsed: string;
  readonly created: string;
}
