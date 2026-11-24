import type { Database } from "bun:sqlite";

/** One step from a schema version to the next. It runs inside a transaction; db.ts sets the version. */
export type Migration = ((db: Database) => void) & {
  /**
   * The migration rebuilds a table other tables refer to. It runs with foreign keys off, so dropping the old table
   * deletes nothing by cascade; db.ts still checks every foreign key before the migration commits.
   */
  rebuilds?: true;
};

// Both baselines are new, and nothing has shipped on them: until this version ships, a schema change edits the baseline
// in db.ts. After that, each change is a migration here, oldest first, and a shipped one is never edited.

/** Every change to the directory since its baseline (version 200): the first is version 201. */
export const DIRECTORY_MIGRATIONS: readonly Migration[] = [
  // 201: every person starts with a shared Portico (stored name "Shared", see STARTER_NAME in core/workspaces.ts).
  // People who came before that get theirs here: empty but for its owner, with no agents.
  (db) => {
    const people = db
      .query(
        `SELECT w.owner_id AS id FROM workspaces w WHERE w.kind = 'personal' AND w.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM workspaces s WHERE s.owner_id = w.owner_id AND s.kind = 'shared' AND s.name = 'Shared')`,
      )
      .all() as { id: string }[];
    const at = new Date().toISOString();
    for (const person of people) {
      const id = crypto.randomUUID();
      db.query("INSERT INTO workspaces (id, name, kind, owner_id, created_at) VALUES ($id, 'Shared', 'shared', $ownerId, $at)").run({ id, ownerId: person.id, at });
      db.query("INSERT INTO workspace_people (workspace_id, person_id, added_at) VALUES ($id, $ownerId, $at)").run({ id, ownerId: person.id, at });
    }
  },
  // 202: a share link remembers whether its maker chose, when making it, to allow messages from the agents of the
  // person the link lets in. Links made before never did.
  (db) => {
    db.run("ALTER TABLE shares ADD COLUMN allow_back INTEGER NOT NULL DEFAULT 0");
  },
  // 203: an app agent Portico can't wake states the minutes between its scheduled inbox checks.
  (db) => {
    db.run("ALTER TABLE agents ADD COLUMN check_minutes INTEGER");
  },
  // 204: feedback agents file with submit_feedback. No foreign keys: an item outlives its agent, and names the agent
  // and the person as they were when the item was sent.
  (db) => {
    db.run(`CREATE TABLE feedback (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('bug', 'idea', 'confusing', 'setup', 'performance', 'security', 'praise', 'other')),
      title TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      person_id TEXT NOT NULL,
      person_handle TEXT,
      created_at TEXT NOT NULL
    )`);
    db.run("CREATE INDEX feedback_created ON feedback (created_at)");
    db.run("CREATE INDEX feedback_agent ON feedback (agent_id, created_at)");
    db.run("CREATE INDEX feedback_person ON feedback (person_id, created_at)");
  },
  // 205: what an agent asks its own person with request_input, and the answer only that person's signed-in browser
  // can give. No foreign keys, as with feedback: a question is the record of who answered what, so the row outlives a
  // removed agent until the history window prunes it; the sweeps withdraw or delete what a removed agent or person
  // leaves. The question and the answer are short text kept here, since a question may belong to no task and so to no
  // Portico's content database. `task_id` is the first message of the task a question is about. `options` is a JSON
  // list of choices and `answer_option` the place of the one pressed. `answered_via` is the path an answer or a skip
  // came by: `web` is Portico's own pages, and `popup` is there for a desktop prompt nothing offers yet, so that one
  // needs no migration. `answer_level` is how far Portico checked who answered: `checked` (a signed-in session of
  // `person_id`) is the only level written today, and the column takes any name, so a stronger one needs no migration.
  // `stakes` is reserved: nothing reads or writes it yet. It is for a question whose asker says the answer needs a
  // stronger level, such as a passkey press. `ended_at` is when the question stopped waiting, however it ended, and
  // `notice_id` the one notice that told the agent.
  (db) => {
    db.run(`CREATE TABLE questions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      task_id TEXT,
      question TEXT NOT NULL,
      detail TEXT,
      options TEXT,
      status TEXT NOT NULL CHECK (status IN ('waiting', 'answered', 'skipped', 'expired', 'withdrawn')),
      answer_option INTEGER,
      answer_text TEXT,
      answered_by TEXT,
      answered_at TEXT,
      answered_via TEXT CHECK (answered_via IN ('web', 'popup')),
      answer_level TEXT,
      stakes TEXT,
      ended_at TEXT,
      notice_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`);
    db.run("CREATE INDEX questions_person ON questions (person_id, status)");
    db.run("CREATE INDEX questions_agent ON questions (agent_id, created_at)");
    db.run("CREATE INDEX questions_task ON questions (task_id)");
    db.run("CREATE INDEX questions_status_expires ON questions (status, expires_at)");
  },
];

/**
 * Every change to a workspace's content database since its baseline (version 1): the first is version 2. Each content
 * database is upgraded when it is next opened, so a feature that lives in a workspace arrives as one migration here.
 */
export const CONTENT_MIGRATIONS: readonly Migration[] = [];
