// Sends a finished email through Yahoo's SMTP server.
import nodemailer from "nodemailer";
import type { YahooConfig } from "./config.js";

export async function sendRaw(
  config: YahooConfig,
  raw: Buffer,
  envelope: { from: string; to: string[] },
): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: true,
    auth: { user: config.email, pass: config.appPassword },
  });
  try {
    const info = await transport.sendMail({ envelope, raw });
    const toStrings = (list: unknown[] = []) =>
      list.map((a) => (typeof a === "string" ? a : String((a as { address?: string }).address ?? a)));
    return {
      messageId: info.messageId,
      accepted: toStrings(info.accepted),
      rejected: toStrings(info.rejected),
    };
  } finally {
    transport.close();
  }
}
