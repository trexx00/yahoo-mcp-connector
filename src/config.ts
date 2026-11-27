// Reads your Yahoo settings from environment variables.
// Locally they come from the .env file; later, on AWS, they come from
// SSM Parameter Store. The code never contains the values themselves.
import "dotenv/config";

export interface YahooConfig {
  email: string;
  appPassword: string;
  imapHost: string;
  imapPort: number;
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
  };
}
