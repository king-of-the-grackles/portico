import type { Database } from "bun:sqlite";
import type { AgentStreams } from "../agent-api/stream";
import type { PersonStreams } from "../api/events";
import type { Desk } from "../desk";
import type { Accounts } from "./accounts";
import type { Activity } from "./activity";
import type { Agents } from "./agents";
import type { AllowList, Approvals } from "./approvals";
import type { Changes } from "./changes";
import type { Computers } from "./computers";
import type { EventSubscriptions } from "./events";
import type { Files } from "./files";
import type { Messages } from "./messages";
import type { People } from "./people";
import type { Presence } from "./presence";
import type { Settings } from "./settings";
import type { Tasks } from "./tasks";
import type { AccountSignIn, CentralSignIn, PorticoConfig } from "./types";
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
  db: Database;
  settings: Settings;
  changes: Changes;
  people: People;
  accounts: Accounts;
  workspaces: Workspaces;
  shares: Shares;
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
  desk: Desk;
  wakeUrls: WakeUrls;
  events: EventSubscriptions;
  /** Hosted Portico's sign-in on the base domain; null where people sign in with a password. */
  central: CentralSignIn | null;
  /** Set where people sign in with an outside account at this Portico's own address (hosted, one database). */
  accountSignIn: AccountSignIn | null;
  now: () => Date;
  newId: () => string;
}
