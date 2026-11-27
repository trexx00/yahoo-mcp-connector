// Preview-then-confirm.
//
// send_email and delete_message never act right away. They store exactly what
// would happen under a one-time code and return a preview. Only confirm_action
// with that code carries it out, and the code works once, then is gone.
// confirm_action takes nothing but the code, so what runs is exactly what was
// previewed: nothing can be swapped in between the two calls.
//
// This store also counts emails sent today, for the daily send limit.
//
// It keeps everything in memory, which is right for the local server (one
// long-running process). On AWS Lambda each request may run in a fresh copy,
// so Step 5 swaps this for a DynamoDB table with the same interface.
import { randomBytes } from "node:crypto";

export type PendingAction =
  | {
      kind: "send";
      raw: Buffer; // the complete email, exactly as it will be sent
      envelope: { from: string; to: string[] };
      preview: Record<string, unknown>;
      /** When sending a saved draft, remove it from Drafts afterwards. */
      draft?: { folder: string; uid: number };
    }
  | {
      kind: "delete";
      folder: string;
      uid: number;
      preview: Record<string, unknown>;
    };

export interface PendingStore {
  put(action: PendingAction, ttlMs: number): Promise<string>;
  /** Returns the action and removes it, so a code can only be used once. */
  take(code: string): Promise<PendingAction | undefined>;
  sentToday(): Promise<number>;
  recordSend(): Promise<void>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10); // UTC date, YYYY-MM-DD
}

export class MemoryPendingStore implements PendingStore {
  private actions = new Map<string, { action: PendingAction; expiresAt: number }>();
  private sends = { day: today(), count: 0 };

  async put(action: PendingAction, ttlMs: number): Promise<string> {
    this.dropExpired();
    const code = randomBytes(6).toString("hex"); // 12 characters, hard to guess
    this.actions.set(code, { action, expiresAt: Date.now() + ttlMs });
    return code;
  }

  async take(code: string): Promise<PendingAction | undefined> {
    this.dropExpired();
    const entry = this.actions.get(code);
    this.actions.delete(code);
    return entry?.action;
  }

  async sentToday(): Promise<number> {
    if (this.sends.day !== today()) this.sends = { day: today(), count: 0 };
    return this.sends.count;
  }

  async recordSend(): Promise<void> {
    await this.sentToday(); // rolls the counter over at midnight UTC
    this.sends.count += 1;
  }

  private dropExpired() {
    const now = Date.now();
    for (const [code, entry] of this.actions) {
      if (entry.expiresAt <= now) this.actions.delete(code);
    }
  }
}
