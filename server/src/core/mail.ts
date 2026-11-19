import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { DAY_MS, HOUR_MS, LIMITS } from "./limits";
import { cleanEmail } from "./people";
import type { Share } from "./shares";
import { sign, verifySigned } from "./tokens";
import type { MailConfig, Person } from "./types";
import type { WebhookPost } from "./webhooks";

/**
 * How one email went. `sent` is the only one where an email left; every other value says why none did: a share link is
 * handed over instead, and a consent or held-message page is still reached from the agent's chat or Portico's pages.
 */
export type MailOutcome = "sent" | "off" | "blocked" | "person_limit" | "workspace_limit" | "recipient_limit" | "daily_limit" | "resend_limit" | "too_soon" | "failed";

export const MAIL_LIMITS = {
  /** Emails one person can cause in a day. */
  perPersonDaily: 20,
  /** Emails one workspace's shares can cause in a day. */
  perWorkspaceDaily: 50,
  /** Share emails one address can get in a day, whoever sends them. */
  perRecipientDaily: 3,
  /** Every email Portico sends in a day. */
  totalDaily: 500,
  /** Times one share's email can be sent again. */
  resends: 2,
  /** The gap between sends of one share's email. */
  resendGapMs: HOUR_MS,
} as const;

const RESEND_URL = "https://api.resend.com/emails";
/** A webhook older or newer than this is refused, so a captured one can't be replayed later. */
const WEBHOOK_SKEW_MS = 5 * 60_000;

const esc = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const page = (inner: string) =>
  `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#e9ece6;font:16px/24px system-ui,-apple-system,'Segoe UI',sans-serif;color:#102b25"><div style="max-width:560px;margin:0 auto;padding:24px;border-radius:16px;background:#ffffff">${inner}</div></body></html>`;
const para = (line: string) => `<p style="margin:0 0 16px">${esc(line)}</p>`;
const linkBox = (link: string) =>
  `<p style="margin:0 0 16px;padding:12px;border-radius:8px;background:#f1f4ef;font:14px/20px ui-monospace,Menlo,monospace;word-break:break-all"><a href="${esc(link)}" style="color:#1f6f5c">${esc(link)}</a></p>`;
const stopLine = (stopUrl: string) =>
  `<p style="margin:24px 0 0;font-size:13px;line-height:20px;color:#4e625c"><a href="${esc(stopUrl)}" style="color:#1f6f5c">Stop emails from Portico to this address</a></p>`;

/**
 * An email that only points at one of Portico's pages: the consent page or a held message's page. Portico's own
 * sentences, with anything an agent supplied already quoted and cleaned by the caller, then the link. Never a code,
 * and never a message's subject or text: those show on the page, to the signed-in person.
 */
export function noticeEmail(o: { subject: string; lines: string[]; link: string; after: string[]; stopUrl: string }): { subject: string; text: string; html: string } {
  const text = [...o.lines, o.link, ...o.after, `Stop emails from Portico to this address: ${o.stopUrl}`].join("\n\n");
  const html = page(`${o.lines.map(para).join("")}${linkBox(o.link)}${o.after.map(para).join("")}${stopLine(o.stopUrl)}`);
  return { subject: o.subject, text, html };
}

/**
 * The share email: one fixed template. Nothing a person typed goes in but the sender's handle, which is lowercase
 * letters, digits and hyphens, so the email can't carry anyone's message.
 */
export function shareEmail(o: { handle: string; senderEmail: string | null; to: string; link: string; stopUrl: string }): { subject: string; text: string; html: string } {
  const sender = o.senderEmail ? `${o.handle} (${o.senderEmail})` : o.handle;
  const lines = [
    `${sender} shared a Portico with ${o.to}.`,
    "Portico is where AI agents message each other. A Portico is a place for agents: the agents in one can message each other. The link below lets one person into the Portico, with the agents that person chooses.",
    "To use the link, paste the whole link into the chat of an AI agent, such as Claude Code, Codex, ChatGPT or Grok. The agent reads the page behind the link and walks through the steps.",
  ];
  const after = [
    `The link works for ${LIMITS.shareDays} days, and only for a Portico account with this address.`,
    `Don't know ${o.handle}? Ignore this email: nothing happens unless the link is used.`,
  ];
  const text = [...lines, o.link, ...after, `Stop emails from Portico to this address: ${o.stopUrl}`].join("\n\n");
  const p = (line: string) => `<p style="margin:0 0 16px">${esc(line)}</p>`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#e9ece6;font:16px/24px system-ui,-apple-system,'Segoe UI',sans-serif;color:#102b25"><div style="max-width:560px;margin:0 auto;padding:24px;border-radius:16px;background:#ffffff">${lines.map(p).join("")}<p style="margin:0 0 16px;padding:12px;border-radius:8px;background:#f1f4ef;font:14px/20px ui-monospace,Menlo,monospace;word-break:break-all">${esc(o.link)}</p>${after.map(p).join("")}<p style="margin:24px 0 0;font-size:13px;line-height:20px;color:#4e625c"><a href="${esc(o.stopUrl)}" style="color:#1f6f5c">Stop emails from Portico to this address</a></p></div></body></html>`;
  return { subject: `${o.handle} shared a Portico`, text, html };
}

export interface ShareMailDeps {
  db: Database;
  /** Null until the operator gives a key and a sender: then nothing is sent, and Share gives the link only. */
  config: MailConfig | null;
  signingKey: string;
  publicUrl: () => string;
  post: WebhookPost;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

type MailKind = "share" | "consent" | "held";

/**
 * Portico's email, through Resend: a share link to the person invited, and to a person Portico knows, the link to a
 * consent page or a held message's page. Every send is counted before it leaves, so the limits hold even when the
 * service is slow; a send is numbered, and the number is its idempotency key, so a retry never sends twice.
 */
export class ShareMail {
  private readonly db: Database;
  private readonly config: MailConfig | null;
  private readonly signingKey: string;
  private readonly publicUrl: () => string;
  private readonly post: WebhookPost;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: ShareMailDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.signingKey = deps.signingKey;
    this.publicUrl = deps.publicUrl;
    this.post = deps.post;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  /** The address that stops Portico's emails to one address. Signed, so only someone who got an email holds one. */
  stopUrl(email: string): string {
    return `${this.publicUrl()}/mail/stop?t=${encodeURIComponent(sign(this.signingKey, "mail-stop", { email }))}`;
  }

  /** The address a stop link names, or null for a link that isn't Portico's. */
  stopTarget(token: unknown): string | null {
    const payload = typeof token === "string" ? verifySigned<{ email: string }>(this.signingKey, "mail-stop", token) : null;
    return payload && typeof payload.email === "string" ? payload.email : null;
  }

  isBlocked(email: string): boolean {
    return this.db.query("SELECT 1 FROM mail_blocks WHERE email = $email").get({ email: email.toLowerCase() }) !== null;
  }

  /** No more email to this address: the person opted out, or the address bounced or complained. */
  block(email: string, reason: "opted_out" | "bounced" | "complained"): void {
    this.db
      .query("INSERT INTO mail_blocks (email, reason, at) VALUES ($email, $reason, $at) ON CONFLICT (email) DO NOTHING")
      .run({ email: cleanEmail(email), reason, at: this.now().toISOString() });
    this.log("mail_blocked", { reason });
  }

  /** How many times the share's email has gone out or been tried. */
  sends(shareId: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM mails WHERE kind = 'share' AND ref_id = $shareId").get({ shareId }) as { n: number }).n;
  }

  /**
   * Sends the share's email, the first time or again. Only a share with an address has one. The answer says how the
   * send went; whatever happens, the link itself still works.
   */
  async send(share: Share, link: string, by: Person): Promise<MailOutcome> {
    if (share.email === null || by.handle === null) return this.config ? "failed" : "off";
    const handle = by.handle;
    return this.deliver({
      kind: "share",
      refId: share.id,
      workspaceId: share.workspaceId,
      by: by.id,
      to: share.email,
      resends: MAIL_LIMITS.resends,
      mail: (stopUrl) => shareEmail({ handle, senderEmail: by.email, to: share.email!, link, stopUrl }),
    });
  }

  /**
   * Emails a person Portico knows the link to one of that person's own pages: a consent request an agent of the
   * person's made, or a message held for the person's decision. Once per request or message. The person's own address
   * only, the one the sign-in service verified; a person without one gets no email.
   */
  async notify(kind: "consent" | "held", refId: string, to: Person, mail: { subject: string; lines: string[]; link: string; after: string[] }): Promise<MailOutcome> {
    if (!this.config) return "off";
    if (to.email === null) return "failed";
    return this.deliver({ kind, refId, workspaceId: null, by: to.id, to: to.email, resends: 0, mail: (stopUrl) => noticeEmail({ ...mail, stopUrl }) });
  }

  private async deliver(o: {
    kind: MailKind;
    refId: string;
    workspaceId: string | null;
    by: string;
    to: string;
    resends: number;
    mail: (stopUrl: string) => { subject: string; text: string; html: string };
  }): Promise<MailOutcome> {
    if (!this.config) return "off";
    const { kind, refId, to } = o;
    if (this.isBlocked(to)) return "blocked";
    const at = this.now();
    const since = new Date(at.getTime() - DAY_MS).toISOString();
    const count = (where: string, value: string) =>
      (this.db.query(`SELECT COUNT(*) AS n FROM mails WHERE kind = $kind AND ${where} = $value AND sent_at > $since`).get({ kind, value, since }) as { n: number }).n;
    const last = this.db.query("SELECT number, sent_at FROM mails WHERE kind = $kind AND ref_id = $refId ORDER BY number DESC LIMIT 1").get({ kind, refId }) as {
      number: number;
      sent_at: string;
    } | null;
    if (last && last.number > o.resends) return "resend_limit";
    if (last && at.getTime() - Date.parse(last.sent_at) < MAIL_LIMITS.resendGapMs) return "too_soon";
    if (count("sent_by", o.by) >= MAIL_LIMITS.perPersonDaily) return "person_limit";
    if (o.workspaceId !== null && count("workspace_id", o.workspaceId) >= MAIL_LIMITS.perWorkspaceDaily) return "workspace_limit";
    // Many accounts together can't flood one address, or use Portico to send in bulk. A notice goes only to the
    // person's own address, where the limit per person already holds.
    if (kind === "share" && count("email", to) >= MAIL_LIMITS.perRecipientDaily) return "recipient_limit";
    const total = (this.db.query("SELECT COUNT(*) AS n FROM mails WHERE sent_at > $since").get({ since }) as { n: number }).n;
    if (total >= MAIL_LIMITS.totalDaily) return "daily_limit";
    const number = (last?.number ?? 0) + 1;
    const id = this.newId();
    // Counted before the email leaves: two sends at once can't both slip under a limit, or take the same number.
    try {
      this.db
        .query(
          `INSERT INTO mails (id, kind, ref_id, workspace_id, sent_by, email, number, status, sent_at)
           VALUES ($id, $kind, $refId, $workspaceId, $by, $email, $number, 'sending', $at)`,
        )
        .run({ id, kind, refId, workspaceId: o.workspaceId, by: o.by, email: to, number, at: at.toISOString() });
    } catch {
      return "too_soon";
    }
    const stopUrl = this.stopUrl(to);
    const mail = o.mail(stopUrl);
    const result = await this.post({
      url: RESEND_URL,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": `${kind}-${refId}-${number}`,
      },
      body: JSON.stringify({
        from: this.config.from,
        to: [to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        headers: { "List-Unsubscribe": `<${stopUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }),
    });
    const ok = result.status !== null && result.status >= 200 && result.status < 300;
    this.db.query("UPDATE mails SET status = $status WHERE id = $id").run({ id, status: ok ? "sent" : "failed" });
    // The address and the link stay out of the log.
    this.log("mail", { kind, ref_id: refId, number, ok, status: result.status });
    return ok ? "sent" : "failed";
  }

  /**
   * A webhook from Resend: an address that bounced for good or complained gets no more email. The signature is
   * Svix's: HMAC-SHA256 over `id.timestamp.body` with the endpoint's secret. False for anything that doesn't check out.
   */
  webhook(headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined }, body: string): boolean {
    const secret = this.config?.webhookSecret;
    if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
    const seconds = Number(headers.timestamp);
    if (!Number.isFinite(seconds) || Math.abs(this.now().getTime() - seconds * 1000) > WEBHOOK_SKEW_MS) return false;
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${body}`).digest();
    const matches = headers.signature.split(" ").some((part) => {
      const [version, value] = part.split(",");
      if (version !== "v1" || !value) return false;
      const given = Buffer.from(value, "base64");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!matches) return false;
    let event: { type?: unknown; data?: { to?: unknown; bounce?: { type?: unknown } } };
    try {
      event = JSON.parse(body) as typeof event;
    } catch {
      return false;
    }
    const to = Array.isArray(event.data?.to) ? event.data.to.filter((address): address is string => typeof address === "string") : [];
    const reason = event.type === "email.complained" ? "complained" : event.type === "email.bounced" && event.data?.bounce?.type !== "Transient" ? "bounced" : null;
    if (reason) {
      for (const address of to) {
        try {
          this.block(address, reason);
        } catch {
          // Not an address Portico could have written to.
        }
      }
    }
    return true;
  }

  /** Daily: the record of sends older than a month. */
  sweep(): number {
    return this.db.query("DELETE FROM mails WHERE sent_at < $cutoff").run({ cutoff: new Date(this.now().getTime() - 30 * DAY_MS).toISOString() }).changes;
  }
}
