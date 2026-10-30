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
import type { Messages } from "./messages";
import type { People } from "./people";
import type { Presence } from "./presence";
import type { Settings } from "./settings";
import type { Tasks } from "./tasks";
import type { PorticoConfig } from "./types";
import type { WakeUrls } from "./wake-urls";

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
  computers: Computers;
  agents: Agents;
  messages: Messages;
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
  now: () => Date;
  newId: () => string;
}
