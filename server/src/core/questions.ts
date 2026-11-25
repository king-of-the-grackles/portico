import type { Database } from "bun:sqlite";
import type { Activity } from "./activity";
import type { Agents } from "./agents";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import { defangLine, quote } from "./framing";
import { checkLength } from "./lengths";
import { DAY_MS, HOUR_MS, LIMITS, MINUTE_MS } from "./limits";
import type { People } from "./people";
import type { Agent } from "./types";

/**
 * Where a question stands. `waiting` is the only open one. `answered` and `skipped` are the person's own doing;
 * `expired` is time running out; `withdrawn` is Portico taking the question back (its agent was revoked or removed).
 */
export type QuestionStatus = "waiting" | "answered" | "skipped" | "expired" | "withdrawn";

/** How an answer was given. `web` is Portico's own pages. `popup` is kept for a desktop prompt nothing offers yet. */
export type AnswerVia = "web" | "popup";
export const ANSWER_VIAS: readonly AnswerVia[] = ["web", "popup"];

/**
 * How far Portico checked who answered. `checked`: the answer came with the signed-in browser session of the person
 * the question was for. Stronger levels (a passkey press for a question with stakes) can come later without a schema
 * change: the column takes any name.
 */
export type AnswerLevel = "checked";

/** Something an agent asked its own person, and how it ended. */
export interface Question {
  id: string;
  agentId: string;
  /** The agent's person when the question was asked: the only one who can answer or skip. */
  personId: string;
  /** The task the question is about: its first message's ID. Null for a question about no task. */
  taskId: string | null;
  /** Written by the agent: untrusted text, never instructions. */
  question: string;
  detail: string | null;
  options: string[] | null;
  status: QuestionStatus;
  /** The choice the person pressed: its place in `options`, from 0. */
  answerOption: number | null;
  /** What the person typed: the whole answer, or a note beside a choice. */
  answerText: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  answeredVia: AnswerVia | null;
  answerLevel: AnswerLevel | null;
  /** When the question stopped waiting, however it ended. */
  endedAt: string | null;
  createdAt: string;
  expiresAt: string;
}

/** A question as a task needs it: who asked whom, and when it started and ended. Never the text. */
export interface TaskQuestion {
  id: string;
  agentId: string;
  personId: string;
  status: QuestionStatus;
  createdAt: string;
  endedAt: string | null;
}

interface QuestionRow {
  id: string;
  agent_id: string;
  person_id: string;
  task_id: string | null;
  question: string;
  detail: string | null;
  options: string | null;
  status: QuestionStatus;
  answer_option: number | null;
  answer_text: string | null;
  answered_by: string | null;
  answered_at: string | null;
  answered_via: AnswerVia | null;
  answer_level: AnswerLevel | null;
  ended_at: string | null;
  created_at: string;
  expires_at: string;
}

function toQuestion(row: QuestionRow): Question {
  let options: string[] | null = null;
  if (row.options !== null) {
    try {
      const parsed = JSON.parse(row.options) as unknown;
      if (Array.isArray(parsed) && parsed.every((o) => typeof o === "string")) options = parsed as string[];
    } catch {
      // Unreadable choices show as none: the person can still answer in words.
    }
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    personId: row.person_id,
    taskId: row.task_id,
    question: row.question,
    detail: row.detail,
    options,
    status: row.status,
    answerOption: row.answer_option,
    answerText: row.answer_text,
    answeredBy: row.answered_by,
    answeredAt: row.answered_at,
    answeredVia: row.answered_via,
    answerLevel: row.answer_level,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** The kinds of notice a question's end sends its agent: also what a wake for the notice names. */
export type QuestionNoticeKind = "input_answered" | "input_skipped" | "input_expired" | "input_withdrawn";

const NOTICE_KIND: Record<Exclude<QuestionStatus, "waiting">, QuestionNoticeKind> = {
  answered: "input_answered",
  skipped: "input_skipped",
  expired: "input_expired",
  withdrawn: "input_withdrawn",
};

export interface QuestionsDeps {
  db: Database;
  agents: Agents;
  people: People;
  activity: Activity;
  changes: Changes;
  publicUrl: () => string;
  /**
   * Saves Portico's notice to the agent, for its next check, and returns the notice's ID. Only a write to the
   * directory: it runs inside the transaction that ends the question.
   */
  saveNotice: (agentId: string, text: string) => string;
  /** The question has ended and its notice is saved: the agent is woken for it, when it can still be reached. */
  wake: (agentId: string, noticeId: string, kind: QuestionNoticeKind) => void;
  /** The two agents of the task a question is about, so both people's pages hear of a change. */
  taskAgents?: (question: Question) => string[];
  /** A question was asked: the person is emailed the page's link. */
  onAsked?: (question: Question) => void;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/** Without control characters other than line breaks and tabs. */
function strip(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

const oneLine = (value: unknown): string => (typeof value === "string" ? strip(value).replace(/\s+/g, " ").trim() : "");

/** "3 days", "1 hour", "30 minutes": how long a question waits, in the largest unit that fits evenly. */
export function waitWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (minutes % 1440 === 0) return count(minutes / 1440, "day");
  if (minutes % 60 === 0) return count(minutes / 60, "hour");
  return count(minutes, "minute");
}

/**
 * Questions agents ask their own person with request_input ("Input needed"). An agent can only ask and wait: every
 * write that answers or skips takes the ID of a signed-in person, which only the person API has, and that person must
 * be the one the question is for. The agent hears how its question ended once, in a notice Portico writes.
 */
export class Questions {
  private readonly db: Database;
  private readonly agents: Agents;
  private readonly people: People;
  private readonly activity: Activity;
  private readonly changes: Changes;
  private readonly publicUrl: () => string;
  private readonly saveNotice: QuestionsDeps["saveNotice"];
  private readonly wake: QuestionsDeps["wake"];
  private readonly taskAgents: (question: Question) => string[];
  private readonly onAsked: (question: Question) => void;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: QuestionsDeps) {
    this.db = deps.db;
    this.agents = deps.agents;
    this.people = deps.people;
    this.activity = deps.activity;
    this.changes = deps.changes;
    this.publicUrl = deps.publicUrl;
    this.saveNotice = deps.saveNotice;
    this.wake = deps.wake;
    this.taskAgents = deps.taskAgents ?? (() => []);
    this.onAsked = deps.onAsked ?? (() => {});
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
  }

  /** The one page where the question's person answers: the link an agent shows its person as is. */
  link(id: string): string {
    return `${this.publicUrl()}/q/${id}`;
  }

  get(id: string): Question | null {
    const row = this.db.query("SELECT * FROM questions WHERE id = $id").get({ id }) as QuestionRow | null;
    return row ? toQuestion(row) : null;
  }

  /** The question, for the person it was asked: anyone else gets null, as for a question that isn't there. */
  forPersonById(personId: string, id: string): Question | null {
    const question = this.get(id);
    return question && question.personId === personId ? question : null;
  }

  /** What waits for the person, oldest first. */
  waitingFor(personId: string): Question[] {
    const rows = this.db
      .query("SELECT * FROM questions WHERE person_id = $personId AND status = 'waiting' AND expires_at > $now ORDER BY created_at, rowid")
      .all({ personId, now: this.now().toISOString() }) as QuestionRow[];
    return rows.map(toQuestion);
  }

  /** The agent's own questions that still wait, oldest first. */
  waitingOf(agentId: string): Question[] {
    const rows = this.db
      .query("SELECT * FROM questions WHERE agent_id = $agentId AND status = 'waiting' AND expires_at > $now ORDER BY created_at, rowid")
      .all({ agentId, now: this.now().toISOString() }) as QuestionRow[];
    return rows.map(toQuestion);
  }

  /** Every question about one task, oldest first, for the person who was asked them. */
  ofTaskFor(personId: string, taskId: string): Question[] {
    const rows = this.db
      .query("SELECT * FROM questions WHERE task_id = $taskId AND person_id = $personId ORDER BY created_at, rowid")
      .all({ taskId, personId }) as QuestionRow[];
    return rows.map(toQuestion);
  }

  /** One task's questions as the task's steps need them: no text. */
  ofTask(taskId: string): TaskQuestion[] {
    return this.taskRows("WHERE task_id = $taskId", { taskId }).get(taskId) ?? [];
  }

  /** Every task's questions, by task. */
  byTask(): Map<string, TaskQuestion[]> {
    return this.taskRows("WHERE task_id IS NOT NULL", {});
  }

  private taskRows(where: string, bindings: Record<string, string>): Map<string, TaskQuestion[]> {
    const rows = this.db
      .query(`SELECT id, task_id, agent_id, person_id, status, created_at, ended_at FROM questions ${where} ORDER BY created_at, rowid`)
      .all(bindings) as { id: string; task_id: string; agent_id: string; person_id: string; status: QuestionStatus; created_at: string; ended_at: string | null }[];
    const byTask = new Map<string, TaskQuestion[]>();
    for (const row of rows) {
      const list = byTask.get(row.task_id) ?? [];
      list.push({ id: row.id, agentId: row.agent_id, personId: row.person_id, status: row.status, createdAt: row.created_at, endedAt: row.ended_at });
      byTask.set(row.task_id, list);
    }
    return byTask;
  }

  /** The question a notice reports on, so the notice goes out in the answer frame. Null for any other notice. */
  ofNotice(noticeId: string): { id: string; status: QuestionStatus; level: AnswerLevel | null; via: AnswerVia | null } | null {
    const row = this.db.query("SELECT id, status, answer_level, answered_via FROM questions WHERE notice_id = $noticeId").get({ noticeId }) as
      | { id: string; status: QuestionStatus; answer_level: AnswerLevel | null; answered_via: AnswerVia | null }
      | null;
    return row ? { id: row.id, status: row.status, level: row.answer_level, via: row.answered_via } : null;
  }

  /** The notices that told the agent how its questions ended: the ones the agent was waiting on. */
  noticesOf(agentId: string): string[] {
    return (this.db.query("SELECT notice_id AS id FROM questions WHERE agent_id = $agentId AND notice_id IS NOT NULL").all({ agentId }) as { id: string }[]).map((row) => row.id);
  }

  /**
   * Saves a question from the agent to its own person. `taskId` is a task the caller already checked the agent is in,
   * or null. Nothing here takes a person to ask: the question always goes to the person who manages the agent.
   */
  ask(agent: Agent, input: { question?: unknown; detail?: unknown; options?: unknown; taskId?: string | null; expiresInMinutes?: unknown }): Question {
    // Read again, not taken from the caller: an agent revoked or removed a moment ago asks nothing.
    const asker = this.agents.get(agent.id);
    if (!asker || asker.revokedAt !== null) throw new PorticoError("not_allowed", "A revoked agent can't ask.");
    const question = oneLine(input.question);
    if (question === "") throw new PorticoError("bad_request", "question must be one line saying what the person is asked.");
    checkLength("question", question, LIMITS.maxQuestionChars);
    const detail = typeof input.detail === "string" ? strip(input.detail).trim() : "";
    if (input.detail !== undefined && input.detail !== null && typeof input.detail !== "string") throw new PorticoError("bad_request", "detail must be text.");
    checkLength("detail", detail, LIMITS.maxQuestionDetailChars);
    const options = this.checkOptions(input.options);
    const expiresMs = this.checkExpiry(input.expiresInMinutes);

    const at = this.now();
    const id = this.newId();
    const iso = at.toISOString();
    // The counts and the insert are one transaction, so two calls at once can't both take the last place.
    this.db.transaction(() => {
      const count = (sql: string, params: Record<string, string>) => (this.db.query(sql).get(params) as { n: number }).n;
      if (count("SELECT COUNT(*) AS n FROM questions WHERE agent_id = $id AND status = 'waiting' AND expires_at > $now", { id: agent.id, now: iso }) >= LIMITS.questionsWaitingPerAgent) {
        throw new PorticoError("rate_limited", `An agent can have ${LIMITS.questionsWaitingPerAgent} questions waiting at once. Nothing was asked: wait for an answer first.`);
      }
      if (count("SELECT COUNT(*) AS n FROM questions WHERE person_id = $id AND status = 'waiting' AND expires_at > $now", { id: agent.ownerId, now: iso }) >= LIMITS.questionsWaitingPerPerson) {
        throw new PorticoError("rate_limited", `One person can have ${LIMITS.questionsWaitingPerPerson} questions waiting at once from every agent together. Nothing was asked: try again later.`);
      }
      if (count("SELECT COUNT(*) AS n FROM questions WHERE agent_id = $id AND created_at > $since", { id: agent.id, since: new Date(at.getTime() - HOUR_MS).toISOString() }) >= LIMITS.questionsPerAgentHour) {
        throw new PorticoError("rate_limited", `An agent can ask ${LIMITS.questionsPerAgentHour} questions an hour. Nothing was asked: try again later.`);
      }
      this.db
        .query(
          `INSERT INTO questions (id, agent_id, person_id, task_id, question, detail, options, status, created_at, expires_at)
           VALUES ($id, $agentId, $personId, $taskId, $question, $detail, $options, 'waiting', $at, $expiresAt)`,
        )
        .run({
          id,
          agentId: agent.id,
          personId: agent.ownerId,
          taskId: input.taskId ?? null,
          question,
          detail: detail === "" ? null : detail,
          options: options ? JSON.stringify(options) : null,
          at: iso,
          expiresAt: new Date(at.getTime() + expiresMs).toISOString(),
        });
      // The record says who asked whom, never what. In the same transaction: a question is never saved without it.
      this.activity.record("input_asked", { agentId: agent.id, subjectId: agent.ownerId, detail: { question: id, ...(input.taskId ? { task: input.taskId } : {}) } });
    })();
    const asked = this.get(id)!;
    this.log("input_asked", { question_id: id, agent_id: agent.id, options: options?.length ?? 0 });
    this.changed(asked);
    this.onAsked(asked);
    return asked;
  }

  private checkOptions(value: unknown): string[] | null {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) throw new PorticoError("bad_request", "options must be a list of choices.");
    if (value.length === 0) return null;
    if (value.length < 2 || value.length > LIMITS.maxQuestionOptions) {
      throw new PorticoError("bad_request", `options must be 2 to ${LIMITS.maxQuestionOptions} choices, or left out for an answer in the person's own words.`);
    }
    const options = value.map(oneLine);
    if (options.some((option) => option === "")) throw new PorticoError("bad_request", "Each choice must be a few words of text.");
    options.forEach((option, i) => checkLength(`options[${i}]`, option, LIMITS.maxQuestionOptionChars));
    if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) throw new PorticoError("bad_request", "Each choice must differ from the others.");
    return options;
  }

  private checkExpiry(value: unknown): number {
    const longest = LIMITS.questionExpiryHours * 60;
    if (value === undefined || value === null) return longest * MINUTE_MS;
    if (typeof value !== "number" || !Number.isInteger(value) || value < LIMITS.questionMinExpiryMinutes || value > longest) {
      throw new PorticoError("bad_request", `expires_in_minutes must be a whole number from ${LIMITS.questionMinExpiryMinutes} to ${longest}.`);
    }
    return value * MINUTE_MS;
  }

  /**
   * The person's answer: a choice, words, or a choice with a note. `personId` is the signed-in person, and must be
   * the one the question is for: anyone else gets "not found". An answer is final.
   */
  answer(personId: string, id: string, input: { option?: unknown; text?: unknown }, via: AnswerVia = "web"): Question {
    const question = this.open(personId, id);
    const text = typeof input.text === "string" ? strip(input.text).trim() : "";
    checkLength("The answer", text, LIMITS.maxAnswerChars);
    let option: number | null = null;
    if (input.option !== undefined && input.option !== null && input.option !== "") {
      const index = typeof input.option === "number" ? input.option : typeof input.option === "string" && /^\d+$/.test(input.option) ? Number(input.option) : Number.NaN;
      if (!question.options || !Number.isInteger(index) || index < 0 || index >= question.options.length) {
        throw new PorticoError("bad_request", "Pick one of the choices, or answer in words.");
      }
      option = index;
    }
    if (option === null && text === "") throw new PorticoError("bad_request", question.options ? "Pick one of the choices, or answer in words." : "Type an answer first.");
    return this.end(question, "answered", { by: personId, via, option, text: text === "" ? null : text });
  }

  /** The person chose not to answer. Final, like an answer. */
  skip(personId: string, id: string, via: AnswerVia = "web"): Question {
    return this.end(this.open(personId, id), "skipped", { by: personId, via, option: null, text: null });
  }

  /**
   * The waiting question, for its own person. Not found for anyone else; a question that ended says how. A question
   * whose agent is gone or revoked takes no answer: it is withdrawn here, whether or not a sweep or the removal
   * itself got to it first, so nothing is ever recorded for an agent that isn't there to hear it.
   */
  private open(personId: string, id: string): Question {
    const question = this.forPersonById(personId, id);
    if (!question) throw new PorticoError("not_found", "No such question.");
    if (question.status === "waiting") {
      const agent = this.agents.get(question.agentId);
      if (!agent || agent.revokedAt !== null) this.end(question, "withdrawn", null);
      else if (question.expiresAt <= this.now().toISOString()) this.end(question, "expired", null);
    }
    const now = this.get(id)!;
    if (now.status !== "waiting") {
      throw new PorticoError(
        "wrong_status",
        now.status === "answered"
          ? "This question was already answered. An answer is final."
          : now.status === "skipped"
            ? "This question was already skipped."
            : now.status === "expired"
              ? "This question waited too long and lapsed."
              : "This question was withdrawn.",
      );
    }
    return now;
  }

  /**
   * Ends a waiting question, once, and all of it or none: the row's new status, the notice to the agent, the
   * notice's ID on the row and the record are one transaction on the directory. The row changes only while it still
   * waits, so two answers at once can't both count; and when any step fails, nothing is kept and the question waits
   * as before, to be answered again. The agent is woken only after everything is saved.
   */
  private end(
    question: Question,
    status: Exclude<QuestionStatus, "waiting">,
    answer: { by: string; via: AnswerVia; option: number | null; text: string | null } | null,
  ): Question {
    const at = status === "expired" ? question.expiresAt : this.now().toISOString();
    const { ended, noticeId } = this.db.transaction(() => {
      const changed = this.db
        .query(
          `UPDATE questions SET status = $status, ended_at = $at, answer_option = $option, answer_text = $text, answered_by = $by,
             answered_at = $answeredAt, answered_via = $via, answer_level = $level
           WHERE id = $id AND status = 'waiting'`,
        )
        .run({
          id: question.id,
          status,
          at,
          option: answer?.option ?? null,
          text: answer?.text ?? null,
          by: answer?.by ?? null,
          answeredAt: status === "answered" ? at : null,
          via: answer?.via ?? null,
          // The only level there is: the signed-in session of the person the question was for.
          level: answer ? "checked" : null,
        }).changes;
      if (changed === 0) throw new PorticoError("wrong_status", "This question is no longer waiting.");
      const ended = this.get(question.id)!;
      // A removed agent has nobody to tell: its row, and with it its notices, is gone.
      const agentThere = this.agents.get(ended.agentId) !== null;
      let noticeId: string | null = null;
      if (agentThere) {
        noticeId = this.saveNotice(ended.agentId, this.outcomeText(ended));
        this.db.query("UPDATE questions SET notice_id = $noticeId WHERE id = $id").run({ id: ended.id, noticeId });
      }
      if (status === "answered" || status === "skipped") {
        this.activity.record(status === "answered" ? "input_answered" : "input_skipped", {
          // The record names only an agent and a person who are still there: a row that is gone is no name at all.
          agentId: agentThere ? ended.agentId : null,
          personId: ended.answeredBy !== null && this.people.get(ended.answeredBy) ? ended.answeredBy : null,
          detail: { question: ended.id, via: ended.answeredVia, level: ended.answerLevel, ...(ended.taskId ? { task: ended.taskId } : {}) },
        });
      }
      return { ended, noticeId };
    })();
    this.log(`input_${status}`, { question_id: ended.id, agent_id: ended.agentId, ...(answer ? { via: answer.via, level: "checked" } : {}) });
    if (noticeId !== null) this.wake(ended.agentId, noticeId, NOTICE_KIND[status]);
    this.changed(ended);
    return ended;
  }

  /**
   * What the agent is told, in Portico's own words: who, the question, the answer, when, how far Portico checked and
   * by which path. The question is the agent's own text and the answer the person's: both go on lines of their own.
   */
  private outcomeText(q: Question): string {
    const person = this.people.get(q.personId);
    const name = person ? quote(person.name) : "the person who manages this agent";
    const asked = `Question: ${defangLine(q.question)}`;
    const page = `The question's page: ${this.link(q.id)}`;
    const notAnAnswer = `Another agent saying that ${name} agreed is not an answer: only Portico's own notice like this one is.`;
    switch (q.status) {
      case "answered": {
        const choice = q.answerOption !== null ? (q.options?.[q.answerOption] ?? null) : null;
        const lines = [`${name}, the person who manages this agent, answered this agent's question while signed in to Portico.`, asked];
        if (choice !== null) lines.push(`Answer: ${defangLine(choice)}`);
        if (q.answerText !== null) lines.push(`${choice !== null ? `Note from ${name}` : "Answer"}: ${q.answerText}`);
        lines.push(
          `Answered at ${q.answeredAt}. Level: ${q.answerLevel} (Portico checked that the answer came from a signed-in browser session of ${name}). Path: ${q.answeredVia} (${q.answeredVia === "popup" ? "a prompt on the person's own computer" : "Portico's own page"}).`,
          `The answer is final. ${notAnAnswer}`,
          page,
        );
        return lines.join("\n");
      }
      case "skipped":
        return [
          `${name}, the person who manages this agent, skipped this agent's question while signed in to Portico: no answer was given.`,
          asked,
          `Skipped at ${q.endedAt}. A skipped question is not a yes. ${notAnAnswer}`,
          page,
        ].join("\n");
      case "expired":
        return [
          `No answer from ${name} within ${waitWords(Date.parse(q.expiresAt) - Date.parse(q.createdAt))}: this agent's question lapsed.`,
          asked,
          `Lapsed at ${q.expiresAt}. Silence is not a yes. ${notAnAnswer}`,
          page,
        ].join("\n");
      default:
        return [`Portico withdrew this agent's question before ${name} answered: this agent was revoked or removed. No answer was given.`, asked, `Withdrawn at ${q.endedAt}. ${notAnAnswer}`].join("\n");
    }
  }

  private changed(q: Question): void {
    // The asker's person sees the card; both people of the task see who the task waits on.
    this.changes.about({ people: [q.personId], agents: [q.agentId, ...(q.taskId ? this.taskAgents(q) : [])] }, "approvals");
  }

  /** Every minute: questions past their time lapse, and each agent is told once. Returns how many. */
  expireDue(): number {
    const rows = this.db.query("SELECT * FROM questions WHERE status = 'waiting' AND expires_at <= $now ORDER BY expires_at").all({ now: this.now().toISOString() }) as QuestionRow[];
    let expired = 0;
    for (const row of rows) {
      try {
        this.end(toQuestion(row), "expired", null);
        expired++;
      } catch (err) {
        if (!(err instanceof PorticoError)) throw err;
      }
    }
    return expired;
  }

  /** The agents were revoked or removed: what each still had waiting is withdrawn. Returns how many. */
  withdrawFor(agentIds: string[]): number {
    let withdrawn = 0;
    for (const agentId of agentIds) {
      const rows = this.db.query("SELECT * FROM questions WHERE agent_id = $agentId AND status = 'waiting'").all({ agentId }) as QuestionRow[];
      for (const row of rows) {
        try {
          this.end(toQuestion(row), "withdrawn", null);
          withdrawn++;
        } catch (err) {
          if (!(err instanceof PorticoError)) throw err;
        }
      }
    }
    return withdrawn;
  }

  /**
   * Every minute: waiting questions whose agent is gone or revoked by a path that names no agent (a removed computer
   * or person takes its agents along) are withdrawn. Returns how many.
   */
  withdrawOrphans(): number {
    const rows = this.db
      .query(
        `SELECT DISTINCT q.agent_id AS id FROM questions q LEFT JOIN agents a ON a.id = q.agent_id
         WHERE q.status = 'waiting' AND (a.id IS NULL OR a.revoked_at IS NOT NULL)`,
      )
      .all() as { id: string }[];
    return this.withdrawFor(rows.map((row) => row.id));
  }

  /**
   * Daily: questions that ended longer ago than the history window, as messages are pruned, and every question of a
   * person who is no longer on Portico. Returns how many.
   */
  prune(): number {
    const cutoff = new Date(this.now().getTime() - LIMITS.historyDays * DAY_MS).toISOString();
    const old = this.db.query("DELETE FROM questions WHERE status != 'waiting' AND COALESCE(ended_at, expires_at) < $cutoff").run({ cutoff }).changes;
    const gone = this.db.query("DELETE FROM questions WHERE person_id NOT IN (SELECT id FROM people)").run().changes;
    return old + gone;
  }
}
