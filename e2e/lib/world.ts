// The cast every scenario shares: test people and their agents, made the first time a scenario asks and reused after
// that, because the server lets one address start only 10 joins per 15 minutes.
//
//   alice: probe, helper        bob: scout, owl
//   The shared Portico holds probe, helper and scout; owl stays in bob's own Portico.
//
// The server also stops a pair of agents at 12 messages in 10 minutes (the loop guard), so scenarios spread their
// messages over the pairs probe-scout and helper-scout: at most 6 each per run, which leaves room for one rerun.
import type { APIRequestContext, Browser, BrowserContext } from "@playwright/test";
import { AgentClient, allowOnConsentPage, joinThroughPage, startJoin } from "./agent";
import { createUser } from "./descope";
import { BASE_URL, nonce, runId } from "./env";
import { newSession, personApi } from "./person";
import { type RunState, type StoredPerson, loadState, saveState } from "./state";

export type Person = StoredPerson & { handle: string; storage: any };

export class World {
  private state: RunState = loadState();
  private clients = new Map<string, AgentClient>();

  constructor(private browser: Browser) {}

  readonly runId = runId();

  // ---- people ----

  /** A new Descope user for this run, not yet signed in to Portico. Deleted by the teardown. */
  async descopeUser(role: string): Promise<{ email: string; name: string; handle: string }> {
    // Resend's test inbox: the deployment sends real notice emails, and an address with no mailbox would bounce.
    const email = `delivered+e2e-${role}-${this.runId}@resend.dev`;
    const name = `E2E ${role[0]!.toUpperCase()}${role.slice(1)} ${this.runId}`;
    if (!this.state.descopeUsers.includes(email)) {
      await createUser(email, name);
      this.state.descopeUsers.push(email);
      saveState(this.state);
    }
    return { email, name, handle: `e2e-${role}-${this.runId}` };
  }

  private handleFor(role: string): string {
    return `e2e-${role}-${this.runId}`;
  }

  /**
   * A person signed in to Portico who has not picked a handle yet: the consent page asks for one with the first
   * Allow. `agent()` fills it in there. Someone the run already knows comes back as they are.
   */
  async newcomer(role: string): Promise<StoredPerson & { storage: any }> {
    const known = this.state.people[role];
    if (known?.storage) return known;
    const user = await this.descopeUser(role);
    const { storage } = await newSession(user.email);
    const person = { role, email: user.email, name: user.name, handle: null, storage };
    this.state.people[role] = person;
    saveState(this.state);
    return person;
  }

  /** A person signed in to Portico with a handle chosen (through the API: the first-run pages have their own scenarios). */
  async person(role: string): Promise<Person> {
    const person = await this.newcomer(role);
    if (person.handle) return person as Person;
    const api = await personApi(person.storage);
    try {
      const res = await api.post("/api/welcome", { data: { name: person.name, handle: this.handleFor(role) } });
      if (!res.ok()) throw new Error(`POST /api/welcome answered ${res.status()}: ${await res.text()}`);
    } finally {
      await api.dispose();
    }
    return this.tookHandle(role);
  }

  private tookHandle(role: string): Person {
    const person = this.state.people[role]!;
    person.handle = this.handleFor(role);
    saveState(this.state);
    return person as Person;
  }

  /** A browser signed in as the person. The caller closes it (the `browserAs` fixture does). */
  contextFor(person: { storage: any }): Promise<BrowserContext> {
    return this.browser.newContext({ baseURL: BASE_URL, storageState: person.storage });
  }

  /** The person API as the person. The caller disposes it. */
  apiFor(person: Person): Promise<APIRequestContext> {
    return personApi(person.storage);
  }

  // ---- agents ----

  hasAgent(role: string, name: string): boolean {
    return `${role}/${name}` in this.state.agents;
  }

  /** Takes an agent a scenario joined itself into the cast, so later scenarios reuse it. */
  adopt(role: string, name: string, token: string): AgentClient {
    this.state.agents[`${role}/${name}`] = { owner: role, name, token };
    saveState(this.state);
    return this.client(role, name, token);
  }

  private client(role: string, name: string, token: string): AgentClient {
    const key = `${role}/${name}`;
    if (!this.clients.has(key)) this.clients.set(key, new AgentClient(role, name, token));
    return this.clients.get(key)!;
  }

  /**
   * The person's agent with this name: joined now if the run has none, through the consent page in a real browser.
   * With a share link, a new agent joins straight into that Portico, and an agent already on Portico comes in with
   * join_portico; either way the person allows it on the consent page, picking a handle there the first time.
   */
  async agent(role: string, name: string, opts: { shareLink?: string; mine?: boolean } = {}): Promise<AgentClient> {
    // A newcomer picks the handle on the consent page, with the first Allow.
    const person = await this.newcomer(role);
    const handle = this.handleFor(role);
    const known = this.state.agents[`${role}/${name}`];
    const context = known && !opts.shareLink ? null : await this.contextFor(person);
    try {
      if (known) {
        const agent = this.client(role, name, known.token);
        if (opts.shareLink) {
          const asked = await agent.call("join_portico", { link: opts.shareLink });
          await allowOnConsentPage(await context!.newPage(), asked.request, { handle });
          this.tookHandle(role);
        }
        return agent;
      }
      const join = await startJoin(name, opts.shareLink);
      const token = await joinThroughPage(await context!.newPage(), join, { handle, mine: opts.mine });
      this.tookHandle(role);
      return this.adopt(role, name, token);
    } finally {
      await context?.close();
    }
  }

  // ---- the shared Portico ----

  rememberShared(shared: { id: string; name: string }): void {
    this.state.shared = shared;
    saveState(this.state);
  }

  /**
   * Deletes every Portico alice made, so a new one is the only place her agents and bob's meet (a new conversation
   * goes through whichever Portico two agents share, and with two of those the scenario couldn't say which).
   * Matters only with kept people: a fresh run has none.
   */
  async dropShared(): Promise<void> {
    const api = await this.apiFor(await this.person("alice"));
    try {
      for (const w of (await (await api.get("/api/porticos")).json()).workspaces) {
        if (w.kind !== "shared" || !w.isOwner) continue;
        const res = await api.delete(`/api/porticos/${w.id}`);
        if (!res.ok()) throw new Error(`DELETE /api/porticos/${w.id} answered ${res.status()}: ${await res.text()}`);
      }
    } finally {
      await api.dispose();
    }
    // People who share no Portico any more are strangers again: the server drops each one's allowance for the other.
    this.state.shared = null;
    this.state.introduced = false;
    saveState(this.state);
  }

  /**
   * The Portico alice made and shared, with alice's probe and helper and bob's scout in it. The two-people scenario makes it on
   * the pages; when that hasn't run, this makes it with the agent tools.
   */
  async shared(): Promise<{ id: string; name: string }> {
    if (this.state.shared) return this.state.shared;
    const alice = await this.person("alice");
    const probe = await this.agent("alice", "probe");
    await this.agent("alice", "helper");
    const name = `E2E Shared ${this.runId} ${nonce(3)}`;
    const { portico } = await probe.call("create_portico", { name, agents: ["probe", "helper"] });
    const asked = await probe.call("share_portico", { portico: portico.id });
    const context = await this.contextFor(alice);
    try {
      await allowOnConsentPage(await context.newPage(), asked.request);
    } finally {
      await context.close();
    }
    const listed = await probe.call("list_porticos");
    const shareLink = listed.waiting.find((w: any) => w.id === asked.request.id)?.share_link;
    if (!shareLink) throw new Error("share_portico was allowed but list_porticos shows no share link.");
    await this.agent("bob", "scout", { shareLink });
    this.rememberShared({ id: portico.id, name });
    await this.introduce();
    return this.state.shared!;
  }

  /** The person's answer to a held message, by the API: for arranging. Scenarios about holds use the page. */
  async decide(role: string, messageId: string, decision: "allow_once" | "always_allow" | "deny"): Promise<void> {
    const api = await this.apiFor(await this.person(role));
    try {
      const res = await api.post(`/api/approvals/held/${messageId}`, { data: { decision } });
      if (!res.ok()) throw new Error(`POST /api/approvals/held/${messageId} answered ${res.status()}: ${await res.text()}`);
    } finally {
      await api.dispose();
    }
  }

  /**
   * Alice and bob each allow the other's agents for good, so later messages between their agents aren't held as
   * first contact. The first-contact scenario undoes this for itself.
   */
  async introduce(): Promise<void> {
    if (this.state.introduced) return;
    const [alice, bob] = [await this.person("alice"), await this.person("bob")];
    const [helper, scout] = [await this.agent("alice", "helper"), await this.agent("bob", "scout")];
    const stamp = Date.now().toString(36);
    const there = await scout.send({ to: `${alice.handle}/helper`, subject: `Introduction ${stamp}`, text: "Hello from scout." });
    if (there.delivery === "held") await this.decide("alice", there.message.id, "always_allow");
    const back = await helper.send({ to: `${bob.handle}/scout`, subject: `Introduction back ${stamp}`, text: "Hello from helper." });
    if (back.delivery === "held") await this.decide("bob", back.message.id, "always_allow");
    this.state.introduced = true;
    saveState(this.state);
  }

  /** The person API's ID for one of the person's own agents. */
  async agentId(role: string, name: string): Promise<string> {
    const api = await this.apiFor(await this.person(role));
    try {
      const found = (await (await api.get("/api/agents")).json()).agents.find((a: any) => a.mine && a.name === name);
      if (!found) throw new Error(`${role} has no agent named ${name}.`);
      return found.id;
    } finally {
      await api.dispose();
    }
  }

  /** The person's ID. */
  async personId(role: string): Promise<string> {
    const api = await this.apiFor(await this.person(role));
    try {
      return (await (await api.get("/api/me")).json()).person.id;
    } finally {
      await api.dispose();
    }
  }
}
