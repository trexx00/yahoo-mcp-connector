// Tools that change things: drafts, sending, moving, flagging and deleting.
//
// Safety rules built in here:
// - send_email and delete_message only PREVIEW. They return a one-time code;
//   confirm_action with that code is the only way to actually send or delete.
// - The server refuses to send more than MAX_SENDS_PER_DAY emails a day.
// - Delete means "move to Trash". Nothing here deletes permanently, except a
//   draft removed from Drafts after it has been sent.
import type { ImapFlow } from "imapflow";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { simpleParser, type ParsedMail } from "mailparser";
import { z } from "zod";
import { bodyText } from "./body.js";
import { buildMime, extractAddresses, replyDetails, type Draft } from "./compose.js";
import type { YahooConfig } from "./config.js";
import { specialFolder } from "./folders.js";
import { inFolder, inFolderReadOnly, withImap } from "./imap.js";
import type { PendingStore } from "./pending.js";
import { sendRaw } from "./smtp.js";

const PREVIEW_CHARS = 3000;

function asJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function asError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

async function fetchParsed(client: ImapFlow, folder: string, uid: number): Promise<ParsedMail> {
  const msg = await inFolderReadOnly(client, folder, () =>
    client.fetchOne(String(uid), { uid: true, source: true }, { uid: true }),
  );
  if (!msg || !msg.source) throw new Error(`No message with uid ${uid} in ${folder}`);
  return simpleParser(msg.source);
}

// Inputs shared by create_draft and send_email.
const composeShape = {
  to: z.array(z.string()).optional().describe('Recipients, e.g. ["Sam <sam@example.com>"]. Optional for replies'),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional().describe("Optional for replies (defaults to Re: original subject)"),
  body: z.string().describe("Plain-text message body"),
  replyToUid: z.number().int().positive().optional().describe("uid of the message being replied to"),
  replyFolder: z.string().default("INBOX").describe("Folder of the message being replied to"),
  replyAll: z.boolean().default(false).describe("Also reply to everyone in To and Cc"),
  includeQuote: z.boolean().default(true).describe("Quote the original message below the reply"),
};
type ComposeArgs = {
  to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; body: string;
  replyToUid?: number; replyFolder: string; replyAll: boolean; includeQuote: boolean;
};

async function composeDraft(client: ImapFlow, config: YahooConfig, args: ComposeArgs): Promise<Draft> {
  let draft: Draft = {
    from: config.email,
    to: args.to ?? [],
    cc: args.cc ?? [],
    bcc: args.bcc ?? [],
    subject: args.subject ?? "",
    text: args.body,
  };

  if (args.replyToUid) {
    const original = await fetchParsed(client, args.replyFolder, args.replyToUid);
    const reply = replyDetails(original, config.email, args.replyAll, bodyText(original).slice(0, 5000));
    draft = {
      ...draft,
      to: args.to?.length ? args.to : reply.to,
      cc: args.cc?.length ? args.cc : reply.cc,
      subject: args.subject ?? reply.subject,
      text: args.includeQuote ? `${args.body}\n\n${reply.quoted}` : args.body,
      inReplyTo: reply.inReplyTo,
      references: reply.references,
    };
  }

  // Validates every address and throws a clear error for a bad one.
  const recipients = [...extractAddresses(draft.to), ...extractAddresses(draft.cc), ...extractAddresses(draft.bcc)];
  if (recipients.length === 0) throw new Error("No recipients. Give `to`, or `replyToUid` for a reply.");
  if (!draft.subject.trim()) throw new Error("A subject is required for a new email.");
  return draft;
}

function previewOf(d: Draft) {
  return {
    from: d.from,
    to: d.to,
    cc: d.cc?.length ? d.cc : undefined,
    bcc: d.bcc?.length ? d.bcc : undefined,
    subject: d.subject,
    isReply: Boolean(d.inReplyTo),
    body: d.text.length > PREVIEW_CHARS ? d.text.slice(0, PREVIEW_CHARS) + "\n…[preview shortened]" : d.text,
  };
}

export function registerActionTools(server: McpServer, config: YahooConfig, store: PendingStore) {
  const ttlMs = config.confirmTtlMinutes * 60_000;

  // create_draft --------------------------------------------------------------
  server.registerTool(
    "create_draft",
    {
      title: "Create a draft",
      description:
        "Save a new email or a reply in the Yahoo Drafts folder. Nothing is sent. " +
        "The user can review and send it from Yahoo Mail, or you can send it later with send_email and draftUid.",
      inputSchema: composeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await withImap(config, async (client) => {
          const draft = await composeDraft(client, config, args);
          const raw = await buildMime(draft);
          const drafts = await specialFolder(client, "\\Drafts");
          const appended = await client.append(drafts, raw, ["\\Draft", "\\Seen"]);
          return { folder: drafts, uid: appended ? appended.uid ?? null : null, preview: previewOf(draft) };
        });
        return asJson({ saved: true, ...result });
      } catch (err) {
        return asError(err);
      }
    },
  );

  // send_email (step 1 of 2) --------------------------------------------------
  server.registerTool(
    "send_email",
    {
      title: "Send an email (preview)",
      description:
        "Step 1 of 2. Prepares a new email, a reply, or a saved draft (draftUid) and returns a PREVIEW " +
        "with a one-time confirmation code. Nothing is sent yet. Show the preview to the user, and only " +
        "after they clearly approve it, call confirm_action with the code. " +
        `Codes expire after ${config.confirmTtlMinutes} minutes.`,
      inputSchema: {
        ...composeShape,
        body: z.string().optional().describe("Plain-text body. Required unless sending a draft"),
        draftUid: z.number().int().positive().optional().describe("Send this saved draft (uid in the Drafts folder) instead"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const sent = await store.sentToday();
        if (sent >= config.maxSendsPerDay) {
          return asError(`Daily send limit reached (${config.maxSendsPerDay}). Try again tomorrow (UTC).`);
        }

        const pending = await withImap(config, async (client) => {
          let draft: Draft;
          let fromDraft: { folder: string; uid: number } | undefined;

          if (args.draftUid) {
            const folder = await specialFolder(client, "\\Drafts");
            const saved = await fetchParsed(client, folder, args.draftUid);
            if (saved.attachments.length) {
              throw new Error("This draft has attachments, which this tool can't send yet. Send it from Yahoo Mail.");
            }
            const list = (a?: ParsedMail["to"]) => (a ? (Array.isArray(a) ? a : [a]).map((x) => x.text) : []);
            const refs = saved.references ? (Array.isArray(saved.references) ? saved.references : [saved.references]) : [];
            draft = {
              from: config.email,
              to: list(saved.to),
              cc: list(saved.cc),
              bcc: list(saved.bcc),
              subject: saved.subject ?? "",
              text: bodyText(saved),
              inReplyTo: saved.inReplyTo,
              references: refs,
            };
            extractAddresses([...draft.to, ...(draft.cc ?? []), ...(draft.bcc ?? [])]);
            fromDraft = { folder, uid: args.draftUid };
          } else {
            if (args.body === undefined) throw new Error("`body` is required unless you give draftUid.");
            draft = await composeDraft(client, config, { ...args, body: args.body });
          }

          const recipients = [
            ...extractAddresses(draft.to),
            ...extractAddresses(draft.cc),
            ...extractAddresses(draft.bcc),
          ];
          if (recipients.length === 0) throw new Error("No recipients.");
          return { draft, recipients, fromDraft };
        });

        const raw = await buildMime(pending.draft);
        const preview = previewOf(pending.draft);
        const code = await store.put(
          {
            kind: "send",
            raw,
            envelope: { from: config.email, to: [...new Set(pending.recipients)] },
            preview,
            draft: pending.fromDraft,
          },
          ttlMs,
        );
        return asJson({
          status: "NOT SENT YET. Show this preview to the user and ask them to approve it.",
          confirmationCode: code,
          expiresInMinutes: config.confirmTtlMinutes,
          sendsLeftToday: config.maxSendsPerDay - sent,
          preview,
        });
      } catch (err) {
        return asError(err);
      }
    },
  );

  // delete_message (step 1 of 2) ----------------------------------------------
  server.registerTool(
    "delete_message",
    {
      title: "Delete a message (preview)",
      description:
        "Step 1 of 2. Shows which message would be moved to Trash and returns a one-time confirmation code. " +
        "Nothing is deleted yet. Confirm with the user, then call confirm_action with the code. " +
        "This never deletes permanently: the message can be recovered from Trash.",
      inputSchema: {
        folder: z.string().default("INBOX"),
        uid: z.number().int().positive(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const preview = await withImap(config, async (client) => {
          const trash = await specialFolder(client, "\\Trash");
          if (trash.toLowerCase() === args.folder.toLowerCase()) {
            throw new Error("That message is already in Trash. This tool never deletes permanently.");
          }
          const msg = await inFolderReadOnly(client, args.folder, () =>
            client.fetchOne(String(args.uid), { uid: true, envelope: true }, { uid: true }),
          );
          if (!msg) throw new Error(`No message with uid ${args.uid} in ${args.folder}`);
          return {
            folder: args.folder,
            uid: args.uid,
            date: msg.envelope?.date ?? null,
            from: msg.envelope?.from?.map((a) => a.address).join(", "),
            subject: msg.envelope?.subject ?? "(no subject)",
            willMoveTo: trash,
          };
        });
        const code = await store.put({ kind: "delete", folder: args.folder, uid: args.uid, preview }, ttlMs);
        return asJson({
          status: "NOT DELETED YET. Confirm with the user first.",
          confirmationCode: code,
          expiresInMinutes: config.confirmTtlMinutes,
          preview,
        });
      } catch (err) {
        return asError(err);
      }
    },
  );

  // confirm_action (step 2 of 2) ----------------------------------------------
  server.registerTool(
    "confirm_action",
    {
      title: "Confirm a send or delete",
      description:
        "Step 2 of 2. Carries out the send or delete that a previous send_email or delete_message previewed. " +
        "Only call this after the user has seen the preview and clearly approved it. Each code works once.",
      inputSchema: { confirmationCode: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ confirmationCode }) => {
      try {
        const action = await store.take(confirmationCode.trim());
        if (!action) {
          return asError("That code is unknown, already used, or expired. Start again with send_email or delete_message.");
        }

        if (action.kind === "send") {
          if ((await store.sentToday()) >= config.maxSendsPerDay) {
            return asError(`Daily send limit reached (${config.maxSendsPerDay}).`);
          }
          const info = await sendRaw(config, action.raw, action.envelope);
          await store.recordSend();

          // Tidy-up steps. The email is already sent, so problems here are reported, not thrown.
          const notes: string[] = [];
          await withImap(config, async (client) => {
            if (config.saveSentCopy) {
              try {
                await client.append(await specialFolder(client, "\\Sent"), action.raw, ["\\Seen"]);
              } catch (e) {
                notes.push(`Sent, but could not save a copy to Sent: ${(e as Error).message}`);
              }
            }
            if (action.draft) {
              try {
                const d = action.draft;
                await inFolder(client, d.folder, () => client.messageDelete(String(d.uid), { uid: true }));
              } catch (e) {
                notes.push(`Sent, but could not remove the draft: ${(e as Error).message}`);
              }
            }
          }).catch((e) => notes.push(`Sent, but follow-up steps failed: ${(e as Error).message}`));

          return asJson({ sent: true, ...info, sendsLeftToday: config.maxSendsPerDay - (await store.sentToday()), notes, preview: action.preview });
        }

        // delete: move to Trash
        const moved = await withImap(config, async (client) => {
          const trash = await specialFolder(client, "\\Trash");
          const res = await inFolder(client, action.folder, () =>
            client.messageMove(String(action.uid), trash, { uid: true }),
          );
          if (!res) throw new Error(`Could not move uid ${action.uid}. It may already have been moved or deleted.`);
          return { trash, newUid: res.uidMap?.get(action.uid) ?? null };
        });
        return asJson({ movedToTrash: true, folder: moved.trash, uidInTrash: moved.newUid, preview: action.preview });
      } catch (err) {
        return asError(err);
      }
    },
  );

  // move_message / archive_message --------------------------------------------
  const moveTo = async (folder: string, uid: number, destination: string) =>
    withImap(config, async (client) => {
      const res = await inFolder(client, folder, () => client.messageMove(String(uid), destination, { uid: true }));
      if (!res) throw new Error(`Could not move uid ${uid} from ${folder}.`);
      return { moved: true, from: folder, to: res.destination, newUid: res.uidMap?.get(uid) ?? null };
    });

  server.registerTool(
    "move_message",
    {
      title: "Move a message",
      description: "Move a message to another folder. The uid changes after a move; the new uid is returned.",
      inputSchema: {
        folder: z.string().default("INBOX").describe("Folder the message is in now"),
        uid: z.number().int().positive(),
        destination: z.string().describe("Exact folder path from list_folders"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return asJson(await moveTo(args.folder, args.uid, args.destination));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "archive_message",
    {
      title: "Archive a message",
      description: "Move a message to the Archive folder.",
      inputSchema: { folder: z.string().default("INBOX"), uid: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const archive = await withImap(config, (client) => specialFolder(client, "\\Archive"));
        return asJson(await moveTo(args.folder, args.uid, archive));
      } catch (err) {
        return asError(err);
      }
    },
  );

  // mark_message --------------------------------------------------------------
  server.registerTool(
    "mark_message",
    {
      title: "Mark read/unread or flag",
      description: "Mark a message read or unread, and/or flagged or unflagged. Leave out what you don't want to change.",
      inputSchema: {
        folder: z.string().default("INBOX"),
        uid: z.number().int().positive(),
        read: z.boolean().optional(),
        flagged: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        if (args.read === undefined && args.flagged === undefined) {
          return asError("Nothing to change: give `read`, `flagged`, or both.");
        }
        await withImap(config, (client) =>
          inFolder(client, args.folder, async () => {
            const range = String(args.uid);
            const opts = { uid: true };
            if (args.read === true) await client.messageFlagsAdd(range, ["\\Seen"], opts);
            if (args.read === false) await client.messageFlagsRemove(range, ["\\Seen"], opts);
            if (args.flagged === true) await client.messageFlagsAdd(range, ["\\Flagged"], opts);
            if (args.flagged === false) await client.messageFlagsRemove(range, ["\\Flagged"], opts);
          }),
        );
        return asJson({ updated: true, folder: args.folder, uid: args.uid, read: args.read, flagged: args.flagged });
      } catch (err) {
        return asError(err);
      }
    },
  );
}
