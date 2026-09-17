import { ObservationPlatform } from "../../kernel/observation.js";
import * as oauthRepo from "../../kernel/state/oauth-repo.js";
import { fetchWithRetry } from "../../kernel/http-retry.js";
import * as scheduler from "../../kernel/scheduler.js";

const observation = ObservationPlatform.getInstance();
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
// Shared with calendar.ts's own PROVIDER constant — Calendar and Gmail
// scopes were both granted in ONE combined OAuth consent (see calendar.ts's
// SCOPE), so there is only ever one token row per (provider="google_calendar",
// username) covering both. This is intentional, not a copy-paste bug.
const PROVIDER = "google_calendar";

export class PersonalGmailError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

async function getValidAccessToken(username: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new PersonalGmailError("Google isn't configured — set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.", 503);
  }

  let stored: Awaited<ReturnType<typeof oauthRepo.getTokens>>;
  try {
    stored = await oauthRepo.getTokens(PROVIDER, username);
  } catch (err: any) {
    // oauthRepo.getTokens() has no internal try/catch of its own — a lookup
    // failure (Postgres unreachable, DNS failure, etc.) rejects rather than
    // resolving to null. From this caller's perspective that's exactly as
    // actionable as "no row for this user": either way there's no usable
    // token, so it's treated the same as not-connected rather than letting a
    // raw DB error leak out where a clear "connect your account" message
    // belongs.
    observation.logTelemetry("warn", "Integrations", `Personal Gmail token lookup failed for "${username}": ${err.message}`);
    stored = null;
  }
  if (!stored) {
    throw new PersonalGmailError("You haven't connected a Google account yet — use Connect Google Account in the dashboard.", 401);
  }
  if (new Date(stored.expiry).getTime() > Date.now() + 60_000) {
    return stored.access_token;
  }
  const res = await fetchWithRetry(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: stored.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  }, { label: "Personal Gmail token refresh" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // A refresh failure here (invalid_grant) means the user revoked access
    // on Google's side, or the refresh token otherwise went stale — this is
    // exactly the reconnect-needed case Task 15 handles. Throwing here with
    // a 401 lets that task's handling recognize it and prompt reconnection.
    //
    // Only a 400/401-class response from Google is actually the "refresh
    // token itself is invalid" (invalid_grant) case — that's the one signal
    // that means reconnecting is genuinely required, so it also gets a
    // durable push notification (fire-and-forget, must not delay this
    // throw). A transient 5xx from Google's token endpoint does NOT fire
    // it: reconnecting wouldn't help with a retry-able blip.
    if (res.status === 400 || res.status === 401) {
      scheduler.pushNotification(
        username,
        "Your Google connection needs renewing, sir — click Connect Google Account again in the dashboard.",
        "warning"
      );
    }
    throw new PersonalGmailError(`Google token refresh failed (${res.status}): ${body}`, 401);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  const expiry = new Date(Date.now() + data.expires_in * 1000);
  await oauthRepo.saveTokens(PROVIDER, username, data.access_token, stored.refresh_token, expiry);
  return data.access_token;
}

async function gmailRequest(username: string, path: string, init: RequestInit = {}): Promise<any> {
  const accessToken = await getValidAccessToken(username);
  const res = await fetchWithRetry(`${GMAIL_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  }, { label: `Gmail API ${init.method || "GET"} ${path}` });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PersonalGmailError(`Gmail API error (${res.status}): ${body}`, res.status);
  }
  return res.json();
}

// Gmail's send endpoint takes a raw base64url-encoded RFC 2822 message, not
// a JSON body of {to, subject, text} — this builds the minimal valid one.
function buildRawMessage(to: string, subject: string, text: string): string {
  // to/subject come straight from LLM tool-call arguments, which can be
  // steered by untrusted text Jarvis ingests (web results, news, emails it
  // reads) — a prompt-injection payload could otherwise smuggle "\r\nBcc:
  // attacker@example.com" (or a blank line + forged body) into these
  // header-position fields. Stripping CR/LF neutralizes header injection;
  // it can't affect `text`, which only ever appears after the blank line.
  const safeTo = to.replace(/[\r\n]/g, " ");
  const safeSubject = subject.replace(/[\r\n]/g, " ");
  const message = [`To: ${safeTo}`, `Subject: ${safeSubject}`, "Content-Type: text/plain; charset=utf-8", "", text].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

export async function sendPersonalEmail(username: string, to: string, subject: string, text: string): Promise<{ messageId: string }> {
  const result = await gmailRequest(username, "/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: buildRawMessage(to, subject, text) }),
  });
  observation.logTelemetry("info", "Integrations", `Personal Gmail sent for "${username}": "${subject}" (${result.id})`);
  return { messageId: result.id };
}

export interface PersonalEmailMessage {
  id: string;
  subject: string;
  from: string;
}

export interface PersonalEmailWatchDeps {
  listConnectedUsernames: () => Promise<string[]>;
  fetchPersonalRecentMessages: (username: string, limit?: number) => Promise<PersonalEmailMessage[]>;
}

const defaultPersonalEmailWatchDeps: PersonalEmailWatchDeps = {
  listConnectedUsernames: () => oauthRepo.listUsernamesWithTokens(PROVIDER),
  // Bound via a wrapper (not a bare function reference) so this always
  // calls the module's CURRENT fetchPersonalRecentMessages, including a
  // test file's own monkeypatched replacement -- a bare reference captured
  // here at module-load time would freeze onto whichever implementation
  // existed first.
  fetchPersonalRecentMessages: (username: string, limit?: number) => fetchPersonalRecentMessages(username, limit),
};

/**
 * Per-user counterpart to scheduler.ts's startEmailWatchJob (which only
 * ever watches the single shared admin IMAP mailbox). This fans out across
 * every account that's connected their own Gmail (oauth_tokens rows for
 * this provider) and notifies EACH one only about THEIR OWN new mail --
 * admin never sees a personal user's email arrive, and vice versa.
 *
 * Implemented here (not in scheduler.ts) specifically to avoid a circular
 * import: this module already imports scheduler.ts for pushNotification
 * (see getValidAccessToken's reconnect-needed notification above), so
 * scheduler.ts importing this module back would create one. server.ts
 * calls this directly, exactly like it already calls every other
 * scheduler.start*Job() function.
 */
export function startPersonalEmailWatchJob(
  intervalMs = 5 * 60 * 1000,
  deps: PersonalEmailWatchDeps = defaultPersonalEmailWatchDeps
): NodeJS.Timeout {
  // One baseline per connected user -- a brand-new connection gets its
  // first poll treated as "establish the baseline," exactly like the
  // shared-mailbox job's own first-run behavior, so connecting an account
  // never dumps a backlog of every pre-existing email as "new."
  const lastSeenByUser = new Map<string, string>();
  return scheduler.registerJob("personal-email-watch", intervalMs, async () => {
    const usernames = await deps.listConnectedUsernames();
    for (const username of usernames) {
      try {
        const messages = await deps.fetchPersonalRecentMessages(username, 5);
        if (messages.length === 0) continue;
        const newestId = messages[0].id; // fetchPersonalRecentMessages returns newest-first (Gmail's own list order)
        const lastSeenId = lastSeenByUser.get(username);
        if (lastSeenId === undefined) {
          lastSeenByUser.set(username, newestId);
          continue;
        }
        if (newestId === lastSeenId) continue; // no new mail since last check
        // Gmail message ids are opaque hex strings, not orderable integers
        // like the shared mailbox's IMAP UIDs -- instead of comparing ids,
        // find where the previously-seen message now sits in this
        // newest-first list; everything before it is new. If it's fallen
        // out of the window entirely (more than 5 arrived since last
        // check), conservatively treat all 5 as new rather than guessing
        // a count beyond what was actually fetched.
        const seenIndex = messages.findIndex(m => m.id === lastSeenId);
        const unseen = seenIndex === -1 ? messages : messages.slice(0, seenIndex);
        if (unseen.length > 0) {
          scheduler.pushNotification(
            username,
            unseen.length === 1
              ? `New email: "${unseen[0].subject}" from ${unseen[0].from}`
              : `${unseen.length} new emails, most recent: "${messages[0].subject}"`,
            "info"
          );
          lastSeenByUser.set(username, newestId);
        }
      } catch (err: any) {
        // One user's expired/revoked Google connection must never stop the
        // rest of this poll cycle from checking everyone else.
        observation.logTelemetry("warn", "Integrations", `Personal email watch failed for "${username}": ${err.message || err}`);
      }
    }
  });
}

// Gmail's messages.list returns bare {id, threadId} stubs, newest-first
// (Gmail's own default/documented order for this endpoint, no sort param
// needed) -- neither subject nor sender is in that response, so each id
// needs its own messages.get call for the headers a useful notification
// needs. format=metadata + metadataHeaders scopes that second call to just
// the two headers wanted, not the full message body.
export async function fetchPersonalRecentMessages(username: string, limit = 10): Promise<PersonalEmailMessage[]> {
  const list = await gmailRequest(username, `/users/me/messages?maxResults=${limit}`);
  const stubs: Array<{ id: string }> = list.messages || [];
  const messages: PersonalEmailMessage[] = [];
  for (const stub of stubs) {
    const detail = await gmailRequest(
      username,
      `/users/me/messages/${stub.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`
    );
    const headers: Array<{ name: string; value: string }> = detail.payload?.headers || [];
    const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
    const from = headers.find(h => h.name === "From")?.value || "unknown";
    messages.push({ id: stub.id, subject, from });
  }
  return messages;
}
