export const GROUPS = [
  "Find and read",
  "Organize",
  "Draft",
  "Send",
  "Trash and delete",
  "Download attachments",
] as const;
export type Group = (typeof GROUPS)[number];
