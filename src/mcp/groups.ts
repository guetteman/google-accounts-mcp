export const GROUPS = [
  "Find and read",
  "Draft",
  "Send",
  "Organize",
  "Trash and delete",
  "Download attachments",
] as const;
export type Group = (typeof GROUPS)[number];
