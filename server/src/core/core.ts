import type { Database } from "bun:sqlite";
import type { AgentStreams } from "../agent-api/stream";
import type { PersonStreams } from "../api/events";
import type { Desk } from "../desk";
import type { Accounts } from "./accounts";
import type { Agents } from "./agents";
import type { AllowList, Approvals } from "./approvals";
import type { Changes } from "./changes";
import type { Computers } from "./computers";
import type { Messages } from "./messages";
import type { People } from "./people";
import type { Presence } from "./presence";
import type { Settings } from "./settings";
import type { PorticoConfig } from "./types";

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
  presence: Presence;
  agentStreams: AgentStreams;
  personStreams: PersonStreams;
  desk: Desk;
  now: () => Date;
  newId: () => string;
}
