// Finds Yahoo's standard folders (Drafts, Sent, Trash, Archive). Servers mark
// them with "special use" flags; Yahoo names them Draft, Sent, Trash, Archive.
import type { ImapFlow } from "imapflow";

type Special = "\\Drafts" | "\\Sent" | "\\Trash" | "\\Archive";

const FALLBACK_NAMES: Record<Special, string[]> = {
  "\\Drafts": ["Draft", "Drafts"],
  "\\Sent": ["Sent", "Sent Items"],
  "\\Trash": ["Trash", "Deleted Items"],
  "\\Archive": ["Archive"],
};

export async function specialFolder(client: ImapFlow, use: Special): Promise<string> {
  const folders = await client.list();
  const bySpecial = folders.find((f) => f.specialUse === use);
  if (bySpecial) return bySpecial.path;
  const names = FALLBACK_NAMES[use].map((n) => n.toLowerCase());
  const byName = folders.find((f) => names.includes(f.path.toLowerCase()));
  if (byName) return byName.path;
  throw new Error(`Could not find the ${use.slice(1)} folder. Run list_folders to see what exists.`);
}
