// A small wrapper around imapflow: open a connection to Yahoo, do one job,
// and always close the connection afterwards. Opening a fresh connection per
// request is what we will also do on AWS Lambda, so local testing matches.
import { ImapFlow } from "imapflow";
import type { YahooConfig } from "./config.js";

export async function withImap<T>(
  config: YahooConfig,
  job: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: { user: config.email, pass: config.appPassword },
    logger: false, // keep mail contents out of logs
  });

  await client.connect();
  try {
    return await job(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

// Opens a folder in READ-ONLY mode, so nothing in Step 2 can change your
// mailbox (no flags, no moves, no deletes), then releases it.
export async function inFolderReadOnly<T>(
  client: ImapFlow,
  folder: string,
  job: () => Promise<T>,
): Promise<T> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    return await job();
  } finally {
    lock.release();
  }
}
