/** Bounds on fields and text supplied by a mail's sender, before page fitting. */
export const PAGE_BODY_BYTES = 2_000_000;
export const MAX_TEXT = 1_000_000;
export const HTML_UNREADABLE = "[The HTML of this message could not be converted to text.]";
export const BODY_PART_LEFT_OUT =
  "[A part of this message's body was left out: it has more than 3 parts that Gmail gives apart.]";
export const BODY_BYTES_LEFT_OUT =
  "[A part of this message's body was left out: the message is too large to read whole.]";
const TEXT_LEFT_OUT =
  "[The rest of this message was left out: it is longer than 1,000,000 characters.]";

const safeEnd = (text: string, end: number): number =>
  /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!) ? end - 1 : end;

export const shorten = (text: string, limit: number): string =>
  text.length > limit ? text.slice(0, safeEnd(text, limit - 1)) + "…" : text;

/** Callers retain at most MAX_TEXT + 1 characters, enough to detect an overflow. */
export const boundedText = (text: string, cut = false): string => {
  if (!cut && text.length <= MAX_TEXT) return text;
  const end = safeEnd(text, MAX_TEXT - TEXT_LEFT_OUT.length - 1);
  return text.slice(0, end) + "\n" + TEXT_LEFT_OUT;
};

/** Keep complete addresses in order, reserving space for the omitted-address count. */
export const boundedRecipients = (addresses: string[]): string[] => {
  if (JSON.stringify(addresses).length <= 4_000) return addresses;
  const kept: string[] = [];
  let size = 2; // JSON array brackets.
  for (const address of addresses) {
    const extra = JSON.stringify(address).length + (kept.length ? 1 : 0);
    const marker = `… and ${addresses.length - kept.length - 1} more`;
    if (size + extra + 1 + JSON.stringify(marker).length > 4_000) break;
    kept.push(address);
    size += extra;
  }
  kept.push(`… and ${addresses.length - kept.length} more`);
  return kept;
};

/** Inline flags must be set before measuring the attachments' JSON. */
export const boundedAttachments = <A>(
  attachments: A[],
): {
  attachments: A[];
  attachments_left_out?: number;
} => {
  let size = 2;
  let count = 0;
  for (const attachment of attachments) {
    const extra = JSON.stringify(attachment).length + (count ? 1 : 0);
    if (size + extra > 6_000) break;
    size += extra;
    count++;
  }
  return {
    attachments: attachments.slice(0, count),
    ...(count < attachments.length ? { attachments_left_out: attachments.length - count } : {}),
  };
};
