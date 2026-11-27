// Reads your Yahoo settings from environment variables.
// Locally they come from the .env file; later, on AWS, they come from
// SSM Parameter Store. The code never contains the values themselves.
import "dotenv/config";

export interface YahooConfig {
  email: string;
  appPassword: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** Most emails the server will send in one day (server-enforced). */
  maxSendsPerDay: number;
  /** Save a copy of each sent email in the Sent folder. */
  saveSentCopy: boolean;
  /** How long a preview code stays valid. */
  confirmTtlMinutes: number;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
  return n;
}

export function loadConfig(): YahooConfig {
  const email = process.env.YAHOO_EMAIL?.trim();
  // Yahoo shows app passwords with spaces for readability; IMAP wants them without.
  const appPassword = process.env.YAHOO_APP_PASSWORD?.replace(/\s+/g, "");

  if (!email || !appPassword) {
    throw new Error(
      "Missing YAHOO_EMAIL or YAHOO_APP_PASSWORD. Copy .env.example to .env and fill it in.",
    );
  }

  return {
    email,
    appPassword,
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993, // IMAP over TLS (encrypted from the first byte)
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465, // SMTP over TLS (encrypted from the first byte)
    maxSendsPerDay: intFromEnv("MAX_SENDS_PER_DAY", 20),
    saveSentCopy: (process.env.SAVE_SENT_COPY ?? "true").trim().toLowerCase() !== "false",
    confirmTtlMinutes: intFromEnv("CONFIRM_TTL_MINUTES", 10),
  };
}
