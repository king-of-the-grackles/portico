import type { Database } from "bun:sqlite";
import type { AgentStreams } from "../agent-api/stream";
import type { PersonStreams } from "../api/events";
import type { Accounts } from "./accounts";
import type { Activity } from "./activity";
import type { Agents } from "./agents";
import type { AllowList, Approvals } from "./approvals";
import type { Changes } from "./changes";
import type { Computers } from "./computers";
import type { Consents } from "./consents";
import type { Content } from "./content";
import type { EventSubscriptions } from "./events";
import type { Files } from "./files";
import type { Messages } from "./messages";
import type { People } from "./people";
import type { Presence } from "./presence";
import type { Settings } from "./settings";
import type { Tasks } from "./tasks";
import type { AccountSignIn, PorticoConfig } from "./types";
import type { WakeUrls } from "./wake-urls";
import type { ShareMail } from "./mail";
import type { Shares } from "./shares";
import type { Workspaces } from "./workspaces";

/**
 * Everything a surface can use: the core modules, the live streams and the clock. Routers take this whole object, so a
 * track that adds a module method needs no new wiring.
 */
export interface Core {
  config: PorticoConfig;
  /** The directory: people, agents, workspaces and who is in each. No route reads message content from here. */
  db: Database;
  /** Each workspace's own content database, by the caller's scope. Routes reach content through the core modules. */
  content: Content;
  settings: Settings;
  changes: Changes;
  people: People;
  accounts: Accounts;
  workspaces: Workspaces;
  shares: Shares;
  /** Everything a person confirms on the consent page: joins, and what agents ask their person. */
  consents: Consents;
  mail: ShareMail;
  computers: Computers;
  agents: Agents;
  messages: Messages;
  files: Files;
  approvals: Approvals;
  allowList: AllowList;
  activity: Activity;
  tasks: Tasks;
  presence: Presence;
  agentStreams: AgentStreams;
  personStreams: PersonStreams;
  wakeUrls: WakeUrls;
  events: EventSubscriptions;
  /** Set where people sign in with an outside account (hosted Portico). Null: this server's own passwords and passkeys. */
  accountSignIn: AccountSignIn | null;
  now: () => Date;
  newId: () => string;
}
