// The shapes Home and Settings render from. Every API shape comes from the person API's views; these types add only
// the page's own state (what is open, what is being edited). Type-only, so the browser build carries nothing.
import type {
  AgentView,
  AllowEntry,
  ClaimView,
  ComputerView,
  HeldCard,
  InviteView,
  MessageView,
  PasskeyView,
  PersonView,
  SignInView,
  ThreadView,
} from "../../../api/views";
import type { AgentKind } from "../../../core/types";

export type {
  AgentKind,
  AgentView,
  AllowEntry,
  ClaimView,
  ComputerView,
  HeldCard,
  InviteView,
  MessageView,
  PasskeyView,
  PersonView,
  SignInView,
  ThreadView,
};

/** A page of a thread, oldest first. `more` says older messages remain: the panel offers Show earlier messages. */
export interface ThreadData {
  thread: ThreadView;
  messages: MessageView[];
  more: boolean;
}

export interface AgentData {
  agent: AgentView;
  allowList: AllowEntry[] | null;
}

/** The right panel on Home: a thread, an agent's details, or an app agent's sign-in request waiting for approval. */
export type OpenPanel =
  | { kind: "thread"; id: string; data: ThreadData | null }
  | { kind: "agent"; id: string; data: AgentData | null }
  | { kind: "signin"; id: string };

/** Home's first data, embedded by the server: the same shapes GET /api/me, /api/agents, /api/approvals and /api/threads answer. */
export interface HomeData {
  page: "home";
  me: PersonView;
  publicUrl: string;
  agents: AgentView[];
  approvals: { held: HeldCard[]; signIns: SignInView[] };
  threads: ThreadView[];
  open: OpenPanel | null;
}

/** A person as GET /api/people lists them: the view plus when the person joined. */
export type PersonRow = PersonView & { joinedAt?: string | null };

/** Settings' first data. People, computers and passkeys load right after, from their own endpoints. */
export interface SettingsData {
  page: "settings";
  me: PersonView;
  publicUrl: string;
  agents: AgentView[];
  people: { people: PersonRow[]; invites: InviteView[]; claims: ClaimView[] } | null;
  computers: ComputerView[] | null;
  passkeys: PasskeyView[] | null;
}

/** A join line just made by POST /api/join-lines. The line carries the secret, so it lives only in the page's memory. */
export interface NewJoinLine {
  id: string;
  kind: AgentKind;
  line: string;
  expiresAt: string;
}

/** The Add agent sheet. */
export interface AddState {
  pick: AgentKind;
  /** Lines made while the sheet is open, one per kind. */
  lines: Partial<Record<AgentKind, NewJoinLine>>;
  lineError: string;
  copied: boolean;
  stage: "pick" | "request" | "joined";
  /** The app agent's sign-in request that arrived on the line. */
  signIn: SignInView | null;
  reqName: string;
  reqError: string;
  joined: AgentView | null;
  busy: boolean;
}

export interface Notice {
  text: string;
  /** A decision's outcome shows a check mark. */
  check?: boolean;
  /** A failed action. */
  error?: boolean;
}

export interface EditState {
  name: string;
  description: string;
  error: string;
}

/** What Home renders. */
export interface HomeState {
  now: number;
  me: PersonView;
  publicUrl: string;
  agents: AgentView[];
  held: HeldCard[];
  signIns: SignInView[];
  threads: ThreadView[];
  open: OpenPanel | null;
  /** The agents list selection that narrows Needs approval and Threads: an agent ID, or "signin:<id>". */
  filter: string | null;
  offlineOpen: boolean;
  acctOpen: boolean;
  /** Phone: the agents list open full screen. */
  agentsOpen: boolean;
  notice: Notice | null;
  reconnecting: boolean;
  add: AddState | null;
  edit: EditState | null;
  saved: boolean;
  expanded: boolean;
  confirmRemove: boolean;
  /** The thread panel is scrolled up from the newest message, so the Newest button shows. */
  threadUp: boolean;
  /** Show earlier messages is fetching. Kept apart from `busy`, so deciding a held message still works meanwhile. */
  loadingEarlier: boolean;
  /** The action in flight, so its button can't be pressed twice. */
  busy: string | null;
}

/** What Settings renders. */
export interface SettingsState {
  now: number;
  me: PersonView;
  publicUrl: string;
  agents: AgentView[];
  people: PersonRow[] | null;
  invites: InviteView[];
  claims: ClaimView[];
  computers: ComputerView[] | null;
  passkeys: PasskeyView[] | null;
  acctOpen: boolean;
  add: AddState | null;
  reconnecting: boolean;
  /** Invite links made in this page, by invite ID: the secret is never stored, so a link shows only once. */
  links: Record<string, string>;
  copied: Record<string, boolean>;
  invite: { name: string; error: string } | null;
  peopleNotice: string;
  compNotice: string;
  confirmMember: string | null;
  confirmComputer: string | null;
  nameForm: { name: string; error: string } | null;
  passwordForm: { current: string; next: string; error: string } | null;
  passwordChanged: boolean;
  passkeyForm: { name: string; error: string } | null;
  /** This browser can make passkeys and Portico serves the passkey module: Add passkey shows. */
  passkeysSupported: boolean;
  accountError: string;
  busy: string | null;
}
