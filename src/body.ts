// Picks the best readable text for an email body.
// Many emails (receipts, newsletters) include a plain-text part that is empty
// or just a line break, with the real content only in the HTML part. In that
// case we convert the HTML to text instead of returning an empty body.
import { convert } from "html-to-text";
import type { ParsedMail } from "mailparser";

export function bodyText(parsed: Pick<ParsedMail, "text" | "html">): string {
  const plain = parsed.text?.trim() ?? "";
  if (plain) return plain;

  if (parsed.html) {
    const fromHtml = convert(parsed.html, {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" }, // images can't be read as text
        { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      ],
    }).trim();
    if (fromHtml) return fromHtml;
  }

  return "(This message has no text content. It may contain only images or attachments.)";
}
