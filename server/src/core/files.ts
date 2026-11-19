import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Agents } from "./agents";
import { PorticoError } from "./errors";
import { type FileStore, FolderStore } from "./file-store";
import { HOUR_MS, LIMITS, MINUTE_MS } from "./limits";
import { letThrough } from "./tasks";
import type { Agent, Message, Person } from "./types";

export interface StoredFile {
  id: string;
  /** The agent that uploaded the file; null once that agent is gone. */
  uploaderId: string | null;
  name: string;
  type: string;
  /** In bytes, as stated when the upload started and checked when it finished. */
  size: number;
  /** ready: every byte has arrived, and the bytes can't change any more. */
  status: "uploading" | "ready";
  checksum: string | null;
  createdAt: string;
  /** When the upload address stops working. Null for text handed over in the call itself. */
  uploadExpiresAt: string | null;
}

/** Where to send a file's bytes: one PUT of the raw bytes, no form and no token. */
export interface UploadSlot {
  method: "PUT";
  url: string;
  expires_at: string;
}

interface FileRow {
  id: string;
  uploader_id: string | null;
  name: string;
  type: string;
  size: number;
  status: string;
  checksum: string | null;
  created_at: string;
  upload_expires_at: string | null;
}

function toFile(row: FileRow): StoredFile {
  return {
    id: row.id,
    uploaderId: row.uploader_id,
    name: row.name,
    type: row.type,
    size: row.size,
    status: row.status as StoredFile["status"],
    checksum: row.checksum,
    createdAt: row.created_at,
    uploadExpiresAt: row.upload_expires_at,
  };
}

const MAX_FILE_BYTES = LIMITS.maxFileMb * 1024 * 1024;
const MAX_INLINE_BYTES = LIMITS.maxInlineFileKb * 1024;
const MAX_STORED_BYTES = LIMITS.maxStoredGb * 1024 * 1024 * 1024;
const MAX_NAME_CHARS = 200;
const TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;

/** A file's name as given: trimmed, one line, no folders, at most 200 characters. */
function checkName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new PorticoError("bad_request", "name is required: the file's name, such as report.pdf.");
  const name = value.trim();
  if (/[\u0000-\u001f\u007f/\\]/.test(name)) throw new PorticoError("bad_request", "name must be a plain file name: one line, no folders.");
  if (name === "." || name === "..") throw new PorticoError("bad_request", "name must be a plain file name.");
  if (Array.from(name).length > MAX_NAME_CHARS) throw new PorticoError("bad_request", `name can be at most ${MAX_NAME_CHARS} characters.`);
  return name;
}

function checkType(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !TYPE.test(value.trim()) || value.trim().length > 100) {
    throw new PorticoError("bad_request", "type must be a media type, such as application/pdf.");
  }
  return value.trim().toLowerCase();
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export interface FilesDeps {
  db: Database;
  store: FileStore;
  agents: Agents;
  /** A message by ID. Passed as a function because messages are wired after files. */
  message: (id: string) => Message | null;
  publicUrl: () => string;
  signingKey: string;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Files that messages carry. An agent starts an upload, sends the bytes, and names the file in send_message. A file
 * can be downloaded by the agent that uploaded it, by the sender and receiver of a message that carries it (the
 * receiver only once a person let that message through), and by the people who manage those agents.
 */
export class Files {
  private readonly db: Database;
  private readonly store: FileStore;
  private readonly agents: Agents;
  private readonly message: (id: string) => Message | null;
  private readonly publicUrl: () => string;
  private readonly signingKey: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  /** Uploads being written to the data folder now, so two can't write one file. */
  private readonly receiving = new Set<string>();

  constructor(deps: FilesDeps) {
    this.db = deps.db;
    this.store = deps.store;
    this.agents = deps.agents;
    this.message = deps.message;
    this.publicUrl = deps.publicUrl;
    this.signingKey = deps.signingKey;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
  }

  /** Whether uploads come through Portico's own route, which then has to accept bodies up to the file limit. */
  get takesUploads(): boolean {
    return this.store instanceof FolderStore;
  }

  get(id: string): StoredFile | null {
    const row = this.db.query("SELECT * FROM files WHERE id = $id").get({ id }) as FileRow | null;
    return row ? toFile(row) : null;
  }

  /**
   * Starts a file. With `text`, the file is that text and is ready at once. Otherwise the answer carries an upload
   * address for `size` bytes, and the file is ready once they arrive. The size counts against the storage cap from now.
   */
  async createUpload(
    agent: Agent,
    input: { name: unknown; type?: unknown; size?: unknown; text?: unknown },
  ): Promise<{ file: StoredFile; upload: UploadSlot | null }> {
    const name = checkName(input.name);
    const inline = input.text !== undefined && input.text !== null;
    const type = checkType(input.type, inline ? "text/plain" : "application/octet-stream");
    let bytes: Uint8Array | null = null;
    let size: number;
    if (inline) {
      if (typeof input.text !== "string" || input.text === "") throw new PorticoError("bad_request", "text must be a non-empty string.");
      bytes = new TextEncoder().encode(input.text);
      if (bytes.length > MAX_INLINE_BYTES) {
        throw new PorticoError(
          "too_large",
          `text is larger than ${LIMITS.maxInlineFileKb} KB. Leave out text, give size in bytes, and PUT the bytes to the upload address.`,
        );
      }
      size = bytes.length;
    } else {
      if (typeof input.size !== "number" || !Number.isInteger(input.size) || input.size < 1) {
        throw new PorticoError("bad_request", "size is required: the file's size in bytes. For a small text file, give text instead.");
      }
      if (input.size > MAX_FILE_BYTES) throw new PorticoError("too_large", `A file can be at most ${LIMITS.maxFileMb} MB.`);
      size = input.size;
    }
    const loose = this.db
      .query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files WHERE uploader_id = $agent
           AND NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = files.id)`,
      )
      .get({ agent: agent.id }) as { n: number; bytes: number };
    if (loose.n >= LIMITS.maxLooseFiles || loose.bytes + size > LIMITS.maxLooseGb * 1024 * 1024 * 1024) {
      throw new PorticoError(
        "rate_limited",
        `This agent already holds ${loose.n} files that no message carries. Send those first, or wait: an unsent file is ` +
          `deleted after ${LIMITS.looseFileHours} hour. The limit is ${LIMITS.maxLooseFiles} files and ${LIMITS.maxLooseGb} GB.`,
      );
    }
    const stored = (this.db.query("SELECT COALESCE(SUM(size), 0) AS n FROM files").get() as { n: number }).n;
    if (stored + size > MAX_STORED_BYTES) {
      throw new PorticoError(
        "too_large",
        `Portico's file storage is full (${LIMITS.maxStoredGb} GB). Files leave with the ${LIMITS.historyDays}-day history.`,
      );
    }
    // Uploads that have started but not arrived will land on the same disk.
    const arriving = (this.db.query("SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE status = 'uploading'").get() as { n: number }).n;
    if (this.store.hasRoom && !this.store.hasRoom(arriving + size)) {
      throw new PorticoError("too_large", "The disk Portico runs on is nearly full, so no file this size fits. A bucket for files lifts this.");
    }
    const id = this.newId();
    const at = this.now();
    const file: StoredFile = {
      id,
      uploaderId: agent.id,
      name,
      type,
      size,
      status: bytes ? "ready" : "uploading",
      checksum: bytes ? sha256(bytes) : null,
      createdAt: at.toISOString(),
      uploadExpiresAt: bytes ? null : new Date(at.getTime() + LIMITS.fileLinkMinutes * MINUTE_MS).toISOString(),
    };
    if (bytes) await this.store.write(id, bytes);
    this.db
      .query(
        `INSERT INTO files (id, uploader_id, name, type, size, status, checksum, created_at, upload_expires_at)
         VALUES ($id, $uploaderId, $name, $type, $size, $status, $checksum, $createdAt, $uploadExpiresAt)`,
      )
      .run({ ...file });
    this.log("file_started", { file_id: id, agent_id: agent.id, size, inline });
    if (bytes) return { file, upload: null };
    const seconds = LIMITS.fileLinkMinutes * 60;
    const url = this.store.uploadUrl(id, seconds) ?? this.signedUrl("put", id, file.uploadExpiresAt!);
    return { file, upload: { method: "PUT", url, expires_at: file.uploadExpiresAt! } };
  }

  /** The file IDs a send names: a list of at most five, each once. */
  ids(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.trim() === "")) {
      throw new PorticoError("bad_request", "attachments must be a list of file IDs from create_upload.");
    }
    const ids = [...new Set((value as string[]).map((id) => id.trim()))];
    if (ids.length > LIMITS.maxFilesPerMessage) {
      throw new PorticoError("bad_request", `A message can carry at most ${LIMITS.maxFilesPerMessage} files.`);
    }
    return ids;
  }

  /**
   * Before a send: finishes the caller's own uploads that went straight to a bucket, by checking that the bytes arrived
   * and are the size stated. An upload of a different size is thrown away.
   */
  async settle(agent: Agent, attachments: unknown): Promise<void> {
    if (this.store instanceof FolderStore) return;
    for (const id of this.ids(attachments)) {
      const file = this.get(id);
      if (!file || file.uploaderId !== agent.id || file.status !== "uploading") continue;
      const stat = await this.store.stat(id);
      if (!stat) continue;
      if (stat.size !== file.size) {
        await this.remove(id, true);
        throw new PorticoError(
          "bad_request",
          `The upload of ${file.name} was ${stat.size} bytes, not the ${file.size} stated, so the file was dropped. Start a new upload.`,
        );
      }
      this.db.query("UPDATE files SET status = 'ready', checksum = $etag WHERE id = $id AND status = 'uploading'").run({ id, etag: stat.etag });
      this.log("file_ready", { file_id: id });
    }
  }

  /** The files a send may carry, checked: each is ready, and the caller's own or one the caller received. */
  attachable(agent: Agent, attachments: unknown): string[] {
    const ids = this.ids(attachments);
    for (const id of ids) {
      const file = this.get(id);
      if (!file || !this.agentMayDownload(agent, file)) {
        throw new PorticoError("bad_request", `No file ${id} that this agent can attach. Start one with create_upload.`);
      }
      if (file.status !== "ready") {
        throw new PorticoError(
          "bad_request",
          `The upload of ${file.name} hasn't finished. PUT the bytes to the upload address, then send again.`,
        );
      }
    }
    return ids;
  }

  /** Puts the files on a message. Run inside the send's transaction. */
  attach(messageId: string, ids: string[]): void {
    const add = this.db.query("INSERT INTO message_files (message_id, file_id, position) VALUES ($messageId, $fileId, $position)");
    ids.forEach((fileId, position) => add.run({ messageId, fileId, position }));
  }

  /** The files a message carries, in the order given. */
  of(messageId: string): StoredFile[] {
    const rows = this.db
      .query("SELECT f.* FROM files f JOIN message_files mf ON mf.file_id = f.id WHERE mf.message_id = $messageId ORDER BY mf.position")
      .all({ messageId }) as FileRow[];
    return rows.map(toFile);
  }

  private carriers(fileId: string): Message[] {
    const rows = this.db.query("SELECT message_id FROM message_files WHERE file_id = $fileId").all({ fileId }) as { message_id: string }[];
    return rows.map((row) => this.message(row.message_id)).filter((m): m is Message => m !== null);
  }

  agentMayDownload(agent: Agent, file: StoredFile): boolean {
    if (file.uploaderId === agent.id) return true;
    return this.carriers(file.id).some((m) => m.fromId === agent.id || (m.toId === agent.id && letThrough(m)));
  }

  /** A person sees files to and from the person's own agents, held ones too. */
  personMayDownload(person: Person, file: StoredFile): boolean {
    const mine = new Set(this.agents.ownedBy(person.id).map((a) => a.id));
    if (file.uploaderId !== null && mine.has(file.uploaderId)) return true;
    return this.carriers(file.id).some((m) => mine.has(m.fromId) || mine.has(m.toId));
  }

  /**
   * A download address that works for a few minutes. A bucket upload's address works for a while after the upload, so
   * the stored bytes are checked against what arrived first on every link until one check after that address has
   * stopped working: the file a person approved is the file anyone downloads.
   */
  async link(file: StoredFile): Promise<{ url: string; expiresAt: string }> {
    if (file.status !== "ready") throw new PorticoError("wrong_status", `The upload of ${file.name} hasn't finished.`);
    const now = this.now();
    if (!(this.store instanceof FolderStore) && file.uploadExpiresAt !== null) {
      let stat: { size: number; etag: string } | null;
      try {
        stat = await this.store.stat(file.id);
      } catch (err) {
        this.log("file_store_unreachable", { file_id: file.id, error: err instanceof Error ? err.name : "unknown" });
        throw new PorticoError("conflict", `Portico couldn't reach file storage to check ${file.name}. Try again in a moment.`);
      }
      if (!stat || stat.size !== file.size || stat.etag !== file.checksum) {
        this.log("file_changed", { file_id: file.id });
        throw new PorticoError("conflict", `${file.name} changed after the upload finished, so Portico won't hand the file out.`);
      }
      // The first check after the upload address stopped working is the last one needed: nothing can write any more.
      if (now.toISOString() >= file.uploadExpiresAt) {
        this.db.query("UPDATE files SET upload_expires_at = NULL WHERE id = $id").run({ id: file.id });
      }
    }
    const expiresAt = new Date(now.getTime() + LIMITS.fileLinkMinutes * MINUTE_MS).toISOString();
    const url = this.store.downloadUrl(file.id, file.name, LIMITS.fileLinkMinutes * 60) ?? this.signedUrl("get", file.id, expiresAt);
    return { url, expiresAt };
  }

  /** A message was declined: its files go, unless another message carries them too. */
  async release(messageId: string): Promise<void> {
    const ids = this.of(messageId).map((file) => file.id);
    this.db.query("DELETE FROM message_files WHERE message_id = $messageId").run({ messageId });
    for (const id of ids) await this.remove(id);
  }

  /** Deletes files no message carries: uploads never attached, and files whose messages left the history. */
  async sweep(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - LIMITS.looseFileHours * HOUR_MS).toISOString();
    const rows = this.db
      .query(
        `SELECT id FROM files WHERE created_at < $cutoff
           AND NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = files.id)`,
      )
      .all({ cutoff }) as { id: string }[];
    let removed = 0;
    for (const { id } of rows) removed += (await this.remove(id)) ? 1 : 0;
    return removed;
  }

  /** Deletes the record, then the bytes: only a file no message carries, unless `force`. */
  private async remove(id: string, force = false): Promise<boolean> {
    // The record goes first, in one step with the check: a send that attaches the file a moment later finds no file,
    // instead of losing the attachment after the fact.
    const gone = this.db
      .query(
        force
          ? "DELETE FROM files WHERE id = $id"
          : "DELETE FROM files WHERE id = $id AND NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = files.id)",
      )
      .run({ id }).changes;
    if (gone === 0) return false;
    this.log("file_removed", { file_id: id });
    try {
      await this.store.remove(id);
    } catch (err) {
      this.log("file_bytes_left", { file_id: id, error: err instanceof Error ? err.name : "unknown" });
    }
    return true;
  }

  // ---- the data folder's own addresses ----

  private signature(op: "put" | "get", id: string, expiresAt: string): string {
    return createHmac("sha256", this.signingKey).update(`file:${op}:${id}:${expiresAt}`).digest("hex");
  }

  private signedUrl(op: "put" | "get", id: string, expiresAt: string): string {
    const exp = Date.parse(expiresAt);
    return `${this.publicUrl()}/files/${encodeURIComponent(id)}?exp=${exp}&sig=${this.signature(op, id, new Date(exp).toISOString())}`;
  }

  /** Whether a /files address is one Portico made for this file and this use, and still in time. */
  signed(op: "put" | "get", id: string, exp: string | undefined, sig: string | undefined): boolean {
    const until = Number(exp);
    if (!exp || !sig || !Number.isInteger(until) || until <= this.now().getTime() || until > 8.64e15) return false;
    const expected = Buffer.from(this.signature(op, id, new Date(until).toISOString()));
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /**
   * Takes an upload's bytes into the data folder, straight to disk. The file is ready when exactly the stated number
   * of bytes arrived; after that the bytes can't be replaced.
   */
  async receive(id: string, body: ReadableStream<Uint8Array> | null): Promise<StoredFile> {
    const store = this.store;
    if (!(store instanceof FolderStore)) throw new PorticoError("not_found", "No such upload.");
    const file = this.get(id);
    if (!file) throw new PorticoError("not_found", "No such upload. Start one with create_upload.");
    if (file.status === "ready") throw new PorticoError("conflict", `${file.name} is already uploaded, and an uploaded file can't change.`);
    if (!body) throw new PorticoError("bad_request", "The request body must be the file's bytes.");
    if (this.receiving.has(id)) throw new PorticoError("conflict", `${file.name} is being uploaded now.`);
    this.receiving.add(id);
    try {
      const sink = Bun.file(store.partPath(id)).writer();
      const hash = new Bun.CryptoHasher("sha256");
      let received = 0;
      try {
        for await (const chunk of body) {
          received += chunk.length;
          if (received > file.size) break;
          hash.update(chunk);
          await sink.write(chunk);
        }
      } finally {
        await sink.end();
      }
      if (received !== file.size) {
        store.discardPart(id);
        throw new PorticoError(
          received > file.size ? "too_large" : "bad_request",
          `The upload of ${file.name} ${received > file.size ? "is larger than" : `was ${received} bytes, not`} the ${file.size} bytes stated. Send exactly the bytes, or start a new upload.`,
        );
      }
      store.keep(id);
      this.db.query("UPDATE files SET status = 'ready', checksum = $checksum WHERE id = $id").run({ id, checksum: hash.digest("hex") });
      this.log("file_ready", { file_id: id });
      return { ...file, status: "ready" };
    } finally {
      this.receiving.delete(id);
    }
  }

  /** Where a ready file's bytes are in the data folder, for the download route. */
  stored(id: string): { file: StoredFile; path: string } | null {
    const file = this.get(id);
    if (!file || file.status !== "ready" || !(this.store instanceof FolderStore)) return null;
    return { file, path: this.store.path(id) };
  }
}
