import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { ObservationPlatform } from "../observation/index.js";

const observation = ObservationPlatform.getInstance();

export class EmailIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

function requireSmtpConfig() {
  const { EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASSWORD } = process.env;
  if (!EMAIL_HOST || !EMAIL_PORT || !EMAIL_USER || !EMAIL_PASSWORD) {
    throw new EmailIntegrationError(
      "EMAIL_HOST/EMAIL_PORT/EMAIL_USER/EMAIL_PASSWORD are not fully set — email sending is unavailable.",
      503
    );
  }
  return { EMAIL_HOST, EMAIL_PORT: Number(EMAIL_PORT), EMAIL_USER, EMAIL_PASSWORD };
}

function requireImapConfig() {
  const { IMAP_HOST, IMAP_PORT, EMAIL_USER, EMAIL_PASSWORD } = process.env;
  if (!IMAP_HOST || !IMAP_PORT || !EMAIL_USER || !EMAIL_PASSWORD) {
    throw new EmailIntegrationError(
      "IMAP_HOST/IMAP_PORT/EMAIL_USER/EMAIL_PASSWORD are not fully set — reading email is unavailable.",
      503
    );
  }
  return { IMAP_HOST, IMAP_PORT: Number(IMAP_PORT), EMAIL_USER, EMAIL_PASSWORD };
}

export async function sendEmail(to: string, subject: string, text: string, html?: string) {
  const { EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASSWORD } = requireSmtpConfig();

  const transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_PORT === 465,
    auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
  });

  const info = await transporter.sendMail({ from: EMAIL_USER, to, subject, text, html });
  observation.logTelemetry("info", "Integrations", `Email sent to ${to}: "${subject}" (${info.messageId})`);
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

export async function fetchRecentMessages(limit = 10) {
  const { IMAP_HOST, IMAP_PORT, EMAIL_USER, EMAIL_PASSWORD } = requireImapConfig();

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: IMAP_PORT === 993,
    auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
    logger: false,
  });

  const messages: any[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const total = client.mailbox && "exists" in client.mailbox ? client.mailbox.exists : 0;
      if (total > 0) {
        const from = Math.max(1, total - limit + 1);
        for await (const msg of client.fetch(`${from}:${total}`, { envelope: true, uid: true })) {
          messages.push({
            uid: msg.uid,
            subject: msg.envelope?.subject,
            from: msg.envelope?.from?.map((a: any) => a.address),
            date: msg.envelope?.date,
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  observation.logTelemetry("info", "Integrations", `Fetched ${messages.length} recent email(s) from INBOX`);
  return messages.reverse();
}
