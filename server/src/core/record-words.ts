import type { ActivityEntry } from "./activity";
import { quote } from "./consent-words";
import { LIMITS } from "./limits";

/** What the sentences of a Portico's record need to name people and agents, as one reader sees them. */
export interface RecordNames {
  /** A person, as Portico names one: the name, with the handle. Null once the person is gone. */
  person(id: string | null): string | null;
  /** An agent, as the reader addresses it: plain for the reader's own, `owner/agent` for anyone else's. Null once gone. */
  agent(id: string | null): string | null;
  /** The address of the person an entry is about, only where the reader may have it (the Portico's owner). */
  email(personId: string | null): string | null;
}

const REFUSED: Record<string, string> = {
  paused: "the Portico is paused",
  rate_limited: "the sender wrote more than Portico's limits allow",
  not_allowed: "the two agents share no Portico",
  unknown_agent: "the name reaches no agent",
};

/**
 * One line of a Portico's record, in Portico's own words: who came in or left, a share, a hold, a refused send, a
 * pause. Never a message's subject or text. A name someone typed is quoted. Null for a kind the record doesn't show.
 */
export function recordWords(entry: ActivityEntry, names: RecordNames): string | null {
  const d = entry.detail;
  const by = names.person(entry.personId) ?? "Someone no longer on Portico";
  const who = names.person(entry.subjectId) ?? "a person no longer on Portico";
  const agent = names.agent(entry.agentId) ?? (typeof d.agent === "string" ? quote(d.agent) : "an agent no longer on Portico");
  const other = names.agent(entry.otherId) ?? (typeof d.other === "string" ? quote(d.other) : "an agent no longer on Portico");
  const count = (n: unknown, one: string, many: string) => (n === "1" ? `1 ${one}` : `${typeof n === "string" ? n : "0"} ${many}`);
  switch (entry.kind) {
    case "portico_person_joined": {
      const email = names.email(entry.subjectId);
      return `${who}${email ? `, ${quote(email)},` : ""} came in with a share link, with ${count(d.agents, "agent", "agents")}.`;
    }
    case "portico_person_left":
      return entry.personId === entry.subjectId
        ? `${who} left, with ${count(d.agents, "agent", "agents")}.`
        : `${by} took ${who} out, with ${count(d.agents, "agent", "agents")}.`;
    case "portico_agent_joined":
      return d.allowed === true ? `${agent} came in, allowed by the owner.` : `${by} put ${agent} in.`;
    case "portico_agent_left":
      return d.revoked === true ? `${agent} was revoked by ${by}, and left.` : `${by} took ${agent} out.`;
    case "portico_shared":
      return `${by} made a share link for one person${d.policy === "ask" ? ", who asks the owner for each agent added later" : ""}.`;
    case "portico_share_ended":
      return `${by} ended a share link.`;
    case "portico_paused":
      return `${by} paused the Portico: nothing moves through the Portico until the owner resumes the Portico.`;
    case "portico_resumed":
      return `${by} resumed the Portico.`;
    case "portico_held":
      return d.for === "outbound"
        ? `A message from ${other} to ${agent} was held for the sender's own person.`
        : d.for === "first_contact"
          ? `A first message from ${other} to ${agent} was held for a decision.`
          : d.for === "new_agent"
            ? `The first message from ${other}, newly joined, to ${agent} was held for a decision.`
          : `A message from ${other} to ${agent} was held for a decision.`;
    case "decision":
      return `${by} ${d.decision === "deny" ? "turned down" : d.decision === "always_allow" ? "allowed, for good," : "allowed"} a held message from ${other} to ${agent}.`;
    case "portico_refused":
      return `A send by ${agent}${entry.otherId ? ` to ${other}` : ""} was refused: ${REFUSED[String(d.reason)] ?? "Portico's rules didn't allow the send"}.`;
    case "portico_burst":
      return `${other} sent ${typeof d.count === "string" ? d.count : "many"} messages to ${who}'s agents within ${LIMITS.burstMinutes} minutes.`;
    case "portico_refusals":
      return `${agent} had ${typeof d.count === "string" ? d.count : "many"} sends refused within ${LIMITS.refusedMinutes} minutes.`;
    default:
      return null;
  }
}
