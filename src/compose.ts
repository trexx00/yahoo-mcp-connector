// Builds complete emails (MIME format) and works out reply details.
// Kept free of network code so it can be unit-tested.
import MailComposer from "nodemailer/lib/mail-composer";
import addressparser from "nodemailer/lib/addressparser";
import type { AddressObject, ParsedMail } from "mailparser";

export interface Draft {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
}

/** Turns entries like "Sam <sam@example.com>, lee@example.com" into bare addresses. */
export function extractAddresses(entries: string[] = []): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    for (const a of addressparser(entry, { flatten: true })) {
      if (a.address && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.address)) out.push(a.address.toLowerCase());
      else throw new Error(`Not a valid email address: "${entry}"`);
    }
  }
  return out;
}

/** Builds the full email. Bcc recipients are left out of the headers. */
export async function buildMime(d: Draft): Promise<Buffer> {
  const composer = new MailComposer({
    from: d.from,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    text: d.text,
    inReplyTo: d.inReplyTo,
    references: d.references,
  });
  return composer.compile().build();
}

function addrList(a?: AddressObject | AddressObject[]): { name: string; address: string }[] {
  if (!a) return [];
  return (Array.isArray(a) ? a : [a]).flatMap((x) =>
    x.value.flatMap((v) => (v.address ? [{ name: v.name, address: v.address.toLowerCase() }] : [])),
  );
}

function formatAddr(a: { name: string; address: string }): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export interface ReplyDetails {
  to: string[];
  cc: string[];
  subject: string;
  inReplyTo?: string;
  references: string[];
  quoted: string;
}

/**
 * Works out who a reply goes to, its subject and the headers that keep it in
 * the same conversation thread. `self` is your own address, which is never
 * added as a recipient on reply-all.
 */
export function replyDetails(original: ParsedMail, self: string, replyAll: boolean, quotedText: string): ReplyDetails {
  const me = self.toLowerCase();
  const replyTarget = addrList(original.replyTo).length ? addrList(original.replyTo) : addrList(original.from);
  const to = replyTarget.filter((a) => a.address !== me);

  let cc: { name: string; address: string }[] = [];
  if (replyAll) {
    const already = new Set(to.map((a) => a.address));
    cc = [...addrList(original.to), ...addrList(original.cc)].filter((a) => {
      if (a.address === me || already.has(a.address)) return false;
      already.add(a.address);
      return true;
    });
  }

  const subject = original.subject ?? "";
  const refs = original.references
    ? Array.isArray(original.references) ? original.references : [original.references]
    : [];
  if (original.messageId) refs.push(original.messageId);

  const when = original.date ? original.date.toUTCString() : "an earlier date";
  const who = addrList(original.from).map(formatAddr).join(", ") || "the sender";
  const quoted =
    `On ${when}, ${who} wrote:\n` +
    quotedText.split("\n").map((line) => `> ${line}`).join("\n");

  return {
    to: (to.length ? to : replyTarget).map(formatAddr),
    cc: cc.map(formatAddr),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    inReplyTo: original.messageId,
    references: refs,
    quoted,
  };
}
