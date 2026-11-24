import { Hono } from "hono";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import type { Question } from "../core/questions";
import type { Person } from "../core/types";
import { log } from "../log";
import { type PersonEnv, currentPerson } from "./context";
import { jsonObject } from "./session";
import { personViews, type QuestionCard } from "./views";

/** What waits for the person's input, oldest first: only what the person's own agents asked. */
export function questionCards(core: Core, me: Person): QuestionCard[] {
  const views = personViews(core, me);
  return core.questions.waitingFor(me.id).map((q) => views.question(q));
}

/** One question as its own person sees it, or null for anyone else: the same as a question that isn't there. */
export function questionCard(core: Core, me: Person, id: string): QuestionCard | null {
  const question: Question | null = core.questions.forPersonById(me.id, id);
  return question ? personViews(core, me).question(question) : null;
}

/**
 * /api/questions: "Input needed". The only place a question is answered or skipped, and like every person route it
 * reads who is asking from the browser's sign-in cookie alone: an agent's token names nobody here. The signed-in
 * person must be the one the question is for; anyone else gets 404, as for a question that isn't there.
 *
 * GET / → `{ questions }`, what waits for the person. GET /:id → `{ question }`.
 * POST /:id `{ decision: "answer", option?, text? }` or `{ decision: "skip" }` → `{ question, next }`.
 */
export function questionRoutes(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();

  route.get("/", (c) => c.json({ questions: questionCards(core, currentPerson(c)) }));

  route.get("/:id", (c) => {
    const card = questionCard(core, currentPerson(c), c.req.param("id"));
    if (!card) throw new PorticoError("not_found", "No such question.");
    return c.json({ question: card });
  });

  route.post("/:id", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    const id = c.req.param("id");
    if (body.decision !== "answer" && body.decision !== "skip") throw new PorticoError("bad_request", "decision must be answer or skip.");
    // The path is this page: the browser the person is signed in with.
    const question = body.decision === "skip" ? core.questions.skip(me.id, id, "web") : core.questions.answer(me.id, id, { option: body.option, text: body.text }, "web");
    log("info", "input_decided", { question_id: question.id, status: question.status });
    return c.json({ question: personViews(core, me).question(question), next: `/q/${id}` });
  });

  return route;
}
