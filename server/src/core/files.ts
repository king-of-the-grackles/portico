import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Agents } from "./agents";
import type { Content, ContentDb } from "./content";
import { PorticoError } from "./errors";
import { type FileStore, FolderStore, uploadKey, workspaceFileKey } from "./file-store";
import { DAY_MS, HOUR_MS, LIMITS, MINUTE_MS } from "./limits";
import { letThrough } from "./tasks";
import type { Agent, Message, Person } from "./types";

export interface StoredFile {
  id: string;
  /**
   * The workspace whose content holds this copy of the file. Null for an upload no message carries yet, which is in no
   * workspace. A file passed on into another workspace has a copy, under the same ID, in each.
   */
  workspaceId: string | null;
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
  /** An upload only: when the upload address stops working. Null for text handed over in the call itself. */
  uploadExpiresAt: string | null;
  /** A workspace's copy only: the key the bytes are still read from while the copy into the workspace is on the way. */
  source: string | null;
}

/** A file a send may carry, with the key its bytes are at now. */
export interface Attachable {
  id: string;
  file: StoredFile;
  key: string;
}

/** Where to send a file's bytes: one PUT of the raw bytes, no form and no token. */
export interface UploadSlot {
  method: "PUT";
  url: string;
  expires_at: string;
}

interface UploadRow {
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

interface FileRow {
  id: string;
  uploader_id: string | null;
  name: string;
  type: string;
  size: number;
  checksum: string | null;
  created_at: string;
  source: string | null;
}

function toUpload(row: UploadRow): StoredFile {
  return {
    id: row.id,
    workspaceId: null,
    uploaderId: row.uploader_id,
    name: row.name,
    type: row.type,
    size: row.size,
    status: row.status as StoredFile["status"],
    checksum: row.checksum,
    createdAt: row.created_at,
    uploadExpiresAt: row.upload_expires_at,
    source: null,
  };
}

/** A workspace's copy: always ready, since only a finished upload can be attached. */
function toFile(row: FileRow, workspaceId: string): StoredFile {
  return {
    id: row.id,
    workspaceId,
    uploaderId: row.uploader_id,
    name: row.name,
    type: row.type,
    size: row.size,
    status: "ready",
    checksum: row.checksum,
    createdAt: row.created_at,
    uploadExpiresAt: null,
    source: row.source,
  };
}

const MAX_FILE_BYTES = LIMITS.maxFileMb * 1024 * 1024;
const MAX_INLINE_BYTES = LIMITS.maxInlineFileKb * 1024;
const MAX_STORED_BYTES = LIMITS.maxStoredGb * 1024 * 1024 * 1024;
const MAX_NAME_CHARS = 200;
const TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
/** An upload a message carries is kept this long after the upload started: long past the copy into the workspace. */
const ATTACHED_UPLOAD_MS = DAY_MS;

/** A file's name as given: trimmed, one line, no folders, at most 200 characters. */
function checkName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new PorticoError("bad_request", "name is required: the file's name, such as report.pdf.");
  const name = value.trim();
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029/\\]/.test(name)) throw new PorticoError("bad_request", "name must be a plain file name: one line, no folders.");
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

const isUploadKey = (key: string) => key.startsWith("uploads/");

export interface FilesDeps {
  /** The directory: uploads no message carries yet are listed there. */
  db: Database;
  /** Each workspace's own database: the files its messages carry are listed there. */
  content: Content;
  store: FileStore;
  agents: Agents;
  publicUrl: () => string;
  signingKey: string;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Files that messages carry. An agent starts an upload, sends the bytes, and names the file in send_message.
 *
 * An upload starts before any message exists, so it is in no workspace: its record is in the directory (`uploads`) and
 * its bytes at `uploads/<id>`. Sending attaches the file in the workspace the message goes through: that workspace's
 * content database gets its own record, and after the send the bytes are copied to `porticos/<workspace>/files/<id>`.
 * A file received in one workspace and passed on into another is copied the same way, so each workspace holds its own
 * copy and deleting one workspace takes nothing from another.
 *
 * A file can be downloaded by the agent that uploaded it, by the sender and receiver of a message that carries it (the
 * receiver only once a person let that message through), and by the people who manage those agents.
 */
export class Files {
  private readonly db: Database;
  private readonly content: Content;
  private readonly store: FileStore;
  private readonly agents: Agents;
  private readonly publicUrl: () => string;
  private readonly signingKey: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  /** Uploads being written to the data folder now, so two can't write one file. */
  private readonly receiving = new Set<string>();
  /** Copies into a workspace under way now, so the sweep doesn't start one twice. */
  private readonly copying = new Set<string>();

  constructor(deps: FilesDeps) {
    this.db = deps.db;
    this.content = deps.content;
    this.store = deps.store;
    this.agents = deps.agents;
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

  // ---- finding a file: always for a caller ----

  /** An upload no message carries yet, by ID. Only the agent that started the upload has any use for the answer. */
  upload(id: string): StoredFile | null {
    const row = this.db.query("SELECT * FROM uploads WHERE id = $id").get({ id }) as UploadRow | null;
    return row ? toUpload(row) : null;
  }

  /**
   * The file with the ID that the agent may download: a copy in a workspace the agent is or was in, on a message the
   * agent sent or received there, or the agent's own upload. Null for any other file, as for one that doesn't exist.
   */
  forAgent(agent: Agent, id: string): StoredFile | null {
    for (const content of this.content.of({ agent: agent.id })) {
      const file = this.fileIn(content, id);
      if (file && this.agentMayDownload(agent, file)) return file;
    }
    const upload = this.upload(id);
    return upload && upload.uploaderId === agent.id ? upload : null;
  }

  /** The file with the ID that the person may download: one to or from the person's own agents, held ones too. */
  forPerson(person: Person, id: string): StoredFile | null {
    for (const content of this.content.of({ person: person.id })) {
      const file = this.fileIn(content, id);
      if (file && this.personMayDownload(person, file)) return file;
    }
    const upload = this.upload(id);
    return upload && this.personMayDownload(person, upload) ? upload : null;
  }

  private fileIn(content: ContentDb, id: string): StoredFile | null {
    const row = content.db.query("SELECT * FROM files WHERE id = $id").get({ id }) as FileRow | null;
    return row ? toFile(row, content.workspaceId) : null;
  }

  // ---- uploads ----

  /**
   * Starts a file. With `text`, the file is that text and is ready at once. Otherwise the answer carries an upload
   * address for `size` bytes, and the file is ready once they arrive.
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
      .query("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM uploads WHERE uploader_id = $agent AND attached_at IS NULL")
      .get({ agent: agent.id }) as { n: number; bytes: number };
    if (loose.n >= LIMITS.maxLooseFiles || loose.bytes + size > LIMITS.maxLooseGb * 1024 * 1024 * 1024) {
      throw new PorticoError(
        "rate_limited",
        `This agent already holds ${loose.n} files that no message carries. Send those first, or wait: an unsent file is ` +
          `deleted after ${LIMITS.looseFileHours} hour. The limit is ${LIMITS.maxLooseFiles} files and ${LIMITS.maxLooseGb} GB.`,
      );
    }
    // Every upload no message carries yet, together: a safety cap, counted from the sizes agents state.
    const waiting = (this.db.query("SELECT COALESCE(SUM(size), 0) AS n FROM uploads WHERE attached_at IS NULL").get() as { n: number }).n;
    if (waiting + size > MAX_STORED_BYTES) {
      throw new PorticoError(
        "too_large",
        `Portico is holding ${LIMITS.maxStoredGb} GB of files that no message carries yet. Try again later: an unsent file is ` +
          `deleted after ${LIMITS.looseFileHours} hour.`,
      );
    }
    // Uploads that have started but not arrived will land on the same disk.
    const arriving = (this.db.query("SELECT COALESCE(SUM(size), 0) AS n FROM uploads WHERE status = 'uploading'").get() as { n: number }).n;
    if (this.store.hasRoom && !this.store.hasRoom(arriving + size)) {
      throw new PorticoError("too_large", "The disk Portico runs on is nearly full, so no file this size fits. A bucket for files lifts this.");
    }
    const id = this.newId();
    const at = this.now();
    const file: StoredFile = {
      id,
      workspaceId: null,
      uploaderId: agent.id,
      name,
      type,
      size,
      status: bytes ? "ready" : "uploading",
      checksum: bytes ? sha256(bytes) : null,
      createdAt: at.toISOString(),
      uploadExpiresAt: bytes ? null : new Date(at.getTime() + LIMITS.fileLinkMinutes * MINUTE_MS).toISOString(),
      source: null,
    };
    if (bytes) await this.store.write(uploadKey(id), bytes);
    this.db
      .query(
        `INSERT INTO uploads (id, uploader_id, name, type, size, status, checksum, created_at, upload_expires_at)
         VALUES ($id, $uploaderId, $name, $type, $size, $status, $checksum, $createdAt, $uploadExpiresAt)`,
      )
      .run({
        id,
        uploaderId: file.uploaderId,
        name,
        type,
        size,
        status: file.status,
        checksum: file.checksum,
        createdAt: file.createdAt,
        uploadExpiresAt: file.uploadExpiresAt,
      });
    this.log("file_started", { file_id: id, agent_id: agent.id, size, inline });
    if (bytes) return { file, upload: null };
    const seconds = LIMITS.fileLinkMinutes * 60;
    const url = this.store.uploadUrl(uploadKey(id), seconds) ?? this.signedUrl("put", null, id, file.uploadExpiresAt!);
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
      const file = this.upload(id);
      if (!file || file.uploaderId !== agent.id || file.status !== "uploading") continue;
      const stat = await this.store.stat(uploadKey(id));
      if (!stat) continue;
      if (stat.size !== file.size) {
        await this.removeUpload(id);
        throw new PorticoError(
          "bad_request",
          `The upload of ${file.name} was ${stat.size} bytes, not the ${file.size} stated, so the file was dropped. Start a new upload.`,
        );
      }
      this.db.query("UPDATE uploads SET status = 'ready', checksum = $etag WHERE id = $id AND status = 'uploading'").run({ id, etag: stat.etag });
      this.log("file_ready", { file_id: id });
    }
  }

  // ---- attaching ----

  /**
   * The files a send may carry, checked, each with the key its bytes are at now: a file the caller uploaded, sent or
   * received in a workspace the caller is or was in, or the caller's own finished upload.
   */
  attachable(agent: Agent, attachments: unknown): Attachable[] {
    return this.ids(attachments).map((id) => {
      const file = this.forAgent(agent, id);
      if (!file) throw new PorticoError("bad_request", `No file ${id} that this agent can attach. Start one with create_upload.`);
      if (file.status !== "ready") {
        throw new PorticoError(
          "bad_request",
          `The upload of ${file.name} hasn't finished. PUT the bytes to the upload address, then send again.`,
        );
      }
      return { id, file, key: this.keyOf(file) };
    });
  }

  /**
   * Puts the files on a message. Run inside the send's transaction in the message's own content database. A file the
   * workspace already has is linked. Any other gets a record there whose `source` is where the bytes are now; `attached`
   * copies them in once the transaction has committed. The workspace's storage cap is checked here, so a send that
   * would pass the cap is refused whole.
   */
  attach(content: ContentDb, messageId: string, files: Attachable[]): void {
    const { db } = content;
    const link = db.query("INSERT INTO message_files (message_id, file_id, position) VALUES ($messageId, $fileId, $position)");
    files.forEach(({ id, file, key }, position) => {
      if (db.query("SELECT 1 FROM files WHERE id = $id").get({ id }) === null) {
        const stored = (db.query("SELECT COALESCE(SUM(size), 0) AS n FROM files").get() as { n: number }).n;
        if (stored + file.size > MAX_STORED_BYTES) {
          throw new PorticoError(
            "too_large",
            `File storage for the Portico this message goes through is full (${LIMITS.maxStoredGb} GB). Files leave with the ${LIMITS.historyDays}-day history.`,
          );
        }
        db.query(
          `INSERT INTO files (id, uploader_id, name, type, size, checksum, created_at, source)
           VALUES ($id, $uploaderId, $name, $type, $size, $checksum, $createdAt, $source)`,
        ).run({
          id,
          uploaderId: file.uploaderId,
          name: file.name,
          type: file.type,
          size: file.size,
          checksum: file.checksum,
          createdAt: file.createdAt,
          source: key,
        });
      }
      link.run({ messageId, fileId: id, position });
    });
  }

  /** After the send's transaction: the uploads are marked as carried, and the bytes start their way into the workspace. */
  attached(message: Message, files: Attachable[]): void {
    const at = this.now().toISOString();
    const mark = this.db.query("UPDATE uploads SET attached_at = $at WHERE id = $id AND attached_at IS NULL");
    for (const { id } of files) mark.run({ id, at });
    void this.copyPending(message.workspaceId);
  }

  /**
   * Copies into the workspace every file whose bytes are still elsewhere, and clears each one's `source`. Runs after a
   * send, and again from the minute sweep for any copy that didn't go through. Returns the sources still waiting.
   */
  async copyPending(workspaceId: string): Promise<string[]> {
    const waiting: string[] = [];
    try {
      const rows = (this.content.find(workspaceId)?.db.query("SELECT * FROM files WHERE source IS NOT NULL").all() ?? []) as FileRow[];
      for (const row of rows) {
        if (!(await this.copyOne(workspaceId, row))) waiting.push(row.source!);
      }
    } catch (err) {
      this.log("file_copy_failed", { workspace_id: workspaceId, error: err instanceof Error ? err.name : "unknown" });
    }
    return waiting;
  }

  /** One file's bytes into the workspace. True once the workspace's copy is the one in use. */
  private async copyOne(workspaceId: string, row: FileRow): Promise<boolean> {
    const source = row.source!;
    const to = workspaceFileKey(workspaceId, row.id);
    const mark = `${workspaceId}/${row.id}`;
    if (this.copying.has(mark)) return false;
    this.copying.add(mark);
    try {
      // A bucket's upload address still works for a while after the upload: only the bytes that arrived first are copied.
      if (isUploadKey(source) && !(await this.uploadIntact(source.slice("uploads/".length)))) {
        this.log("file_changed", { file_id: row.id, workspace_id: workspaceId });
        return false;
      }
      await this.store.copy(source, to);
      // Asked for again: the database is never kept across an await.
      const cleared = this.content
        .stored(workspaceId)
        ?.db.query("UPDATE files SET source = NULL WHERE id = $id AND source = $source")
        .run({ id: row.id, source }).changes;
      // The record went while the bytes were on their way (the message was declined, or the workspace removed).
      if (cleared !== 1) {
        await this.store.remove(to);
        return false;
      }
      this.log("file_copied", { file_id: row.id, workspace_id: workspaceId });
      return true;
    } catch (err) {
      this.log("file_copy_failed", { file_id: row.id, workspace_id: workspaceId, error: err instanceof Error ? err.name : "unknown" });
      return false;
    } finally {
      this.copying.delete(mark);
    }
  }

  /** The files a message carries, in the order given. */
  of(message: Pick<Message, "id" | "workspaceId">): StoredFile[] {
    const content = this.content.find(message.workspaceId);
    if (!content) return [];
    const rows = content.db
      .query("SELECT f.* FROM files f JOIN message_files mf ON mf.file_id = f.id WHERE mf.message_id = $messageId ORDER BY mf.position")
      .all({ messageId: message.id }) as FileRow[];
    return rows.map((row) => toFile(row, content.workspaceId));
  }

  // ---- who may download ----

  /** The messages that carry the workspace's copy of the file: who sent and received each, and whether it was let through. */
  private carriers(file: StoredFile): Pick<Message, "fromId" | "toId" | "heldAt" | "decision">[] {
    const content = file.workspaceId === null ? null : this.content.find(file.workspaceId);
    if (!content) return [];
    const rows = content.db
      .query(
        `SELECT m.from_id, m.to_id, m.held_at, m.decision FROM message_files mf JOIN messages m ON m.id = mf.message_id
         WHERE mf.file_id = $fileId`,
      )
      .all({ fileId: file.id }) as { from_id: string; to_id: string; held_at: string | null; decision: Message["decision"] }[];
    return rows.map((row) => ({ fromId: row.from_id, toId: row.to_id, heldAt: row.held_at, decision: row.decision }));
  }

  /**
   * An upload no message carries yet is its uploader's alone. A workspace's copy is for the sender and receiver of a
   * message there that carries it, the receiver only once a person let that message through. Having uploaded the file
   * gives nothing more: a copy someone passed on into another workspace belongs to that conversation.
   */
  agentMayDownload(agent: Agent, file: StoredFile): boolean {
    if (file.workspaceId === null) return file.uploaderId === agent.id;
    return this.carriers(file).some((m) => m.fromId === agent.id || (m.toId === agent.id && letThrough(m)));
  }

  /** A person sees files to and from the person's own agents, held ones too, and the uploads of those agents. */
  personMayDownload(person: Person, file: StoredFile): boolean {
    const mine = new Set(this.agents.ownedBy(person.id).map((a) => a.id));
    if (file.workspaceId === null) return file.uploaderId !== null && mine.has(file.uploaderId);
    return this.carriers(file).some((m) => mine.has(m.fromId) || mine.has(m.toId));
  }

  /** The key the file's bytes are read from: the upload, the workspace's own copy, or the source while that copy is on the way. */
  private keyOf(file: StoredFile): string {
    if (file.workspaceId === null) return uploadKey(file.id);
    return file.source ?? workspaceFileKey(file.workspaceId, file.id);
  }

  /**
   * A download address that works for a few minutes. A bucket upload's address works for a while after the upload, so
   * while a file's bytes are still read from the upload, the stored bytes are checked against what arrived first on
   * every link: the file a person approved is the file anyone downloads. A workspace's own copy can't be written to
   * through any address, so it needs no check.
   */
  async link(file: StoredFile): Promise<{ url: string; expiresAt: string }> {
    if (file.status !== "ready") throw new PorticoError("wrong_status", `The upload of ${file.name} hasn't finished.`);
    const now = this.now();
    const key = this.keyOf(file);
    if (isUploadKey(key)) {
      let intact: boolean;
      try {
        intact = await this.uploadIntact(key.slice("uploads/".length));
      } catch (err) {
        this.log("file_store_unreachable", { file_id: file.id, error: err instanceof Error ? err.name : "unknown" });
        throw new PorticoError("conflict", `Portico couldn't reach file storage to check ${file.name}. Try again in a moment.`);
      }
      if (!intact) {
        this.log("file_changed", { file_id: file.id });
        throw new PorticoError("conflict", `${file.name} changed after the upload finished, so Portico won't hand the file out.`);
      }
    }
    const expiresAt = new Date(now.getTime() + LIMITS.fileLinkMinutes * MINUTE_MS).toISOString();
    const url =
      this.store.downloadUrl(key, file.name, LIMITS.fileLinkMinutes * 60) ?? this.signedUrl("get", file.workspaceId, file.id, expiresAt);
    return { url, expiresAt };
  }

  /**
   * Whether an upload's stored bytes are still the ones that arrived first. Only a bucket needs the check, and only
   * while the upload address may still work: the first check after that address stopped working is the last one needed,
   * since nothing can write any more. Throws when the bucket can't be reached.
   */
  private async uploadIntact(id: string): Promise<boolean> {
    if (this.store instanceof FolderStore) return true;
    const upload = this.upload(id);
    if (!upload) return false;
    if (upload.uploadExpiresAt === null) return true;
    const stat = await this.store.stat(uploadKey(id));
    if (!stat || stat.size !== upload.size || stat.etag !== upload.checksum) return false;
    if (this.now().toISOString() >= upload.uploadExpiresAt) {
      this.db.query("UPDATE uploads SET upload_expires_at = NULL WHERE id = $id").run({ id });
    }
    return true;
  }

  // ---- removals and sweeps ----

  /**
   * A message was declined: the workspace's copies of its files go, unless another message there carries them too. The
   * upload a file came from goes as well, once no workspace of the agent that uploaded it holds the file any more, so
   * a declined file isn't kept around to be sent again.
   */
  async release(message: Pick<Message, "id" | "workspaceId">): Promise<void> {
    const content = this.content.find(message.workspaceId);
    if (!content) return;
    const ids = this.of(message).map((file) => file.id);
    content.db.query("DELETE FROM message_files WHERE message_id = $messageId").run({ messageId: message.id });
    const gone = ids.filter((id) => this.dropRecord(content.db, id));
    for (const id of gone) {
      await this.removeBytes(workspaceFileKey(message.workspaceId, id), id);
      const upload = this.upload(id);
      if (!upload) continue;
      // Only the uploader attaches straight from an upload, so its workspaces are the only ones that could hold a copy.
      const held = upload.uploaderId !== null && this.content.of({ agent: upload.uploaderId }).some((c) => this.fileIn(c, id) !== null);
      if (!held) await this.removeUpload(id);
    }
  }

  /**
   * In every workspace: finishes copies that didn't go through, and deletes files no message carries any more (their
   * messages left the history). Then deletes uploads by age alone: one never attached after an hour, and one a message
   * carries a day after it started, by when the workspace has its own copy. Returns how many files went.
   */
  async sweep(): Promise<number> {
    let removed = 0;
    const waiting = new Set<string>();
    await this.content.eachAsync(async ({ db, workspaceId }) => {
      const pending = db.query("SELECT * FROM files WHERE source IS NOT NULL").all() as FileRow[];
      for (const row of pending) if (!(await this.copyOne(workspaceId, row))) waiting.add(row.source!);
      const loose = db.query("SELECT id FROM files WHERE NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = files.id)").all() as { id: string }[];
      for (const { id } of loose) {
        if (!this.dropRecord(db, id)) continue;
        await this.removeBytes(workspaceFileKey(workspaceId, id), id);
        removed++;
      }
    });
    const at = this.now().getTime();
    const rows = this.db
      .query(
        `SELECT id FROM uploads WHERE (attached_at IS NULL AND created_at < $loose) OR (attached_at IS NOT NULL AND created_at < $carried)`,
      )
      .all({ loose: new Date(at - LIMITS.looseFileHours * HOUR_MS).toISOString(), carried: new Date(at - ATTACHED_UPLOAD_MS).toISOString() }) as {
      id: string;
    }[];
    for (const { id } of rows) {
      // A workspace still reads its bytes from this upload: the copy hasn't gone through yet.
      if (waiting.has(uploadKey(id))) continue;
      const loose = (this.db.query("SELECT attached_at FROM uploads WHERE id = $id").get({ id }) as { attached_at: string | null } | null)?.attached_at === null;
      if (await this.removeUpload(id)) removed += loose ? 1 : 0;
    }
    return removed;
  }

  /**
   * Removes everything a workspace's content holds: each file's bytes, then the content database and the workspace's
   * folder. For a deleted workspace whose history has emptied, after its directory row is gone, and for a folder a
   * crash left behind. Returns how many files went.
   */
  async dropWorkspace(workspaceId: string): Promise<number> {
    const ids = ((this.content.stored(workspaceId)?.db.query("SELECT id FROM files").all() ?? []) as { id: string }[]).map((row) => row.id);
    for (const id of ids) await this.removeBytes(workspaceFileKey(workspaceId, id), id);
    this.content.remove(workspaceId);
    return ids.length;
  }

  /** Deletes a workspace's record of a file no message there carries. False when a message still does. */
  private dropRecord(db: Database, id: string): boolean {
    // In one step with the check: a send that attaches the file a moment later finds no record, and makes a new one.
    const gone = db.query("DELETE FROM files WHERE id = $id AND NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = files.id)").run({ id }).changes;
    if (gone > 0) this.log("file_removed", { file_id: id });
    return gone > 0;
  }

  /** Deletes an upload's record, then its bytes. */
  private async removeUpload(id: string): Promise<boolean> {
    if (this.db.query("DELETE FROM uploads WHERE id = $id").run({ id }).changes === 0) return false;
    this.log("upload_removed", { file_id: id });
    await this.removeBytes(uploadKey(id), id);
    return true;
  }

  private async removeBytes(key: string, id: string): Promise<void> {
    try {
      await this.store.remove(key);
    } catch (err) {
      this.log("file_bytes_left", { file_id: id, error: err instanceof Error ? err.name : "unknown" });
    }
  }

  // ---- the data folder's own addresses ----

  /** The signature names the use, the workspace whose copy is read (none for an upload), the file and the time. */
  private signature(op: "put" | "get", workspaceId: string | null, id: string, expiresAt: string): string {
    return createHmac("sha256", this.signingKey).update(`file:${op}:${workspaceId ?? ""}:${id}:${expiresAt}`).digest("hex");
  }

  private signedUrl(op: "put" | "get", workspaceId: string | null, id: string, expiresAt: string): string {
    const exp = Date.parse(expiresAt);
    const workspace = workspaceId === null ? "" : `w=${encodeURIComponent(workspaceId)}&`;
    return `${this.publicUrl()}/files/${encodeURIComponent(id)}?${workspace}exp=${exp}&sig=${this.signature(op, workspaceId, id, new Date(exp).toISOString())}`;
  }

  /** Whether a /files address is one Portico made for this file, this workspace's copy and this use, and still in time. */
  signed(op: "put" | "get", workspaceId: string | null, id: string, exp: string | undefined, sig: string | undefined): boolean {
    const until = Number(exp);
    if (!exp || !sig || !Number.isInteger(until) || until <= this.now().getTime() || until > 8.64e15) return false;
    const expected = Buffer.from(this.signature(op, workspaceId, id, new Date(until).toISOString()));
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
    const file = this.upload(id);
    if (!file) throw new PorticoError("not_found", "No such upload. Start one with create_upload.");
    if (file.status === "ready") throw new PorticoError("conflict", `${file.name} is already uploaded, and an uploaded file can't change.`);
    if (!body) throw new PorticoError("bad_request", "The request body must be the file's bytes.");
    if (this.receiving.has(id)) throw new PorticoError("conflict", `${file.name} is being uploaded now.`);
    this.receiving.add(id);
    const key = uploadKey(id);
    try {
      const sink = Bun.file(store.partPath(key)).writer();
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
        store.discardPart(key);
        throw new PorticoError(
          received > file.size ? "too_large" : "bad_request",
          `The upload of ${file.name} ${received > file.size ? "is larger than" : `was ${received} bytes, not`} the ${file.size} bytes stated. Send exactly the bytes, or start a new upload.`,
        );
      }
      store.keep(key);
      this.db.query("UPDATE uploads SET status = 'ready', checksum = $checksum WHERE id = $id").run({ id, checksum: hash.digest("hex") });
      this.log("file_ready", { file_id: id });
      return { ...file, status: "ready" };
    } finally {
      this.receiving.delete(id);
    }
  }

  /**
   * Where a ready file's bytes are in the data folder, for the download route: the workspace's copy the signed address
   * names, or the upload when the address names no workspace.
   */
  stored(workspaceId: string | null, id: string): { file: StoredFile; path: string } | null {
    if (!(this.store instanceof FolderStore)) return null;
    const content = workspaceId === null ? null : this.content.find(workspaceId);
    const file = workspaceId === null ? this.upload(id) : content ? this.fileIn(content, id) : null;
    if (!file || file.status !== "ready") return null;
    return { file, path: this.store.path(this.keyOf(file)) };
  }
}
