// The shapes Home and Settings render from. Every API shape comes from the person API's views; these types add only
// the page's own state (what is open, what is being edited). Type-only, so the browser build carries nothing.
import type { AgentPageData } from "../../../api/agents";
import type { TaskListData, TodayData } from "../../../api/tasks";
import type {
  ActivityView,
  AgentRef,
  AgentView,
  AllowEntry,
  ClaimView,
  ComputerView,
  FileView,
  HeldCard,
  InviteView,
  MessageView,
  PasskeyView,
  PersonRef,
  PersonView,
  RunView,
  SignInView,
  TaskView,
} from "../../../api/views";
import type { AskView, JoinView, ShareView, WorkspacePageData, WorkspaceView } from "../../../api/workspaces";
import type { TaskOutcome } from "../../../core/tasks";
import type { AgentKind } from "../../../core/types";

export type { AskView, JoinView, ShareView, WorkspacePageData, WorkspaceView };
export type {
  ActivityView,
  AgentKind,
  AgentPageData,
  AgentRef,
  AgentView,
  AllowEntry,
  ClaimView,
  ComputerView,
  FileView,
  HeldCard,
  InviteView,
  MessageView,
  PasskeyView,
  PersonRef,
  PersonView,
  RunView,
  SignInView,
  TaskListData,
  TaskOutcome,
  TaskView,
  TodayData,
};

/** Which page of the control plane is showing: Today (/), Activity (/activity) or an agent's page (/a/:id). */
export type Route =
  | { page: "today" }
  | { page: "activity" }
  | { page: "agent"; id: string }
  /** With workspaces: one workspace's page (/w/:id), and every agent with its workspaces (/agents). */
  | { page: "workspace"; id: string }
  | { page: "agents" };

/** What GET /api/tasks/:id answers: one task's steps and every message in it, oldest first. */
export interface TaskDetail {
  task: TaskView;
  messages: MessageView[];
}

/** The Activity page's filters. */
export interface ActivityFilter {
  outcome: TaskOutcome | null;
  agent: string | null;
  project: string | null;
}

/** Home's first data, embedded by the server: the same shapes the person API answers, for the page the URL names. */
export interface HomeData {
  page: "home";
  me: PersonView;
  publicUrl: string;
  agents: AgentView[];
  approvals: { held: HeldCard[]; signIns: SignInView[]; joins: JoinView[]; asks: AskView[] };
  /** The person's workspaces, Personal first. Null where Portico has no workspaces. */
  workspaces: WorkspaceView[] | null;
  workspacePage: WorkspacePageData | null;
  route: Route;
  today: TodayData | null;
  tasks: TaskListData | null;
  agentPage: AgentPageData | null;
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
  /** False on hosted Portico, where sign-in happens on the base domain: no password to change. */
  passwords?: boolean;
  /** With workspaces, people come and go by sharing a workspace, and each person has a handle. */
  workspaces?: boolean;
}

/** A join line just made by POST /api/join-lines. The line carries the secret, so it lives only in the page's memory. */
export interface NewJoinLine {
  id: string;
  line: string;
  expiresAt: string;
}

/** The Add agent sheet. */
export interface AddState {
  /** The join line made when the sheet opened: one line works for every kind of agent. */
  line: NewJoinLine | null;
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

/** The wake URL form in an agent's Settings. */
export interface WakeEditState {
  url: string;
  key: string;
  error: string;
}

/** The form open on a workspace's page or the Agents page. */
export type WorkspaceForm =
  /** A new shared workspace. `thenShare` opens Share on it afterwards: sharing from Personal starts here. */
  | { kind: "new"; name: string; agentIds: string[]; thenShare: boolean; error: string }
  | { kind: "rename"; name: string; error: string }
  | { kind: "share"; email: string; error: string }
  /** My agents not in the workspace yet, ticked to put in. */
  | { kind: "agents"; agentIds: string[]; error: string };

/** What Today, Activity and the agent pages render. */
export interface HomeState {
  now: number;
  me: PersonView;
  publicUrl: string;
  agents: AgentView[];
  held: HeldCard[];
  signIns: SignInView[];
  joins: JoinView[];
  asks: AskView[];
  workspaces: WorkspaceView[] | null;
  workspacePage: WorkspacePageData | null;
  wsForm: WorkspaceForm | null;
  /** The People list on a workspace's page. */
  peopleOpen: boolean;
  /** What waits for a second press: `delete`, `leave`, `person:<id>` or `share:<id>`. */
  wsConfirm: string | null;
  /** Share links copied in this page, by share ID. */
  wsCopied: Record<string, boolean>;
  /** How the last share's email went, by share ID. */
  wsMail: Record<string, string>;
  route: Route;
  today: TodayData | null;
  /** Activity's tasks, or an agent page's, for the current filters. */
  tasks: TaskListData | null;
  filter: ActivityFilter;
  /** Activity: joins, sessions and setting changes shown among the tasks. */
  showEvents: boolean;
  events: ActivityView[] | null;
  agentPage: AgentPageData | null;
  /** Task rows opened to show their steps, by task ID; null while loading. */
  openTasks: Record<string, TaskDetail | null>;
  /** Decision cards showing the whole message. */
  shownMessages: Record<string, boolean>;
  /** The agent page's folds. */
  detailsOpen: boolean;
  settingsOpen: boolean;
  quietOpen: boolean;
  acctOpen: boolean;
  /** Phone: the navigation open over the page. */
  navOpen: boolean;
  notice: Notice | null;
  reconnecting: boolean;
  add: AddState | null;
  edit: EditState | null;
  wakeEdit: WakeEditState | null;
  saved: boolean;
  confirmRemove: boolean;
  loadingMore: boolean;
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
  /** Whether this Portico has passwords to change. */
  passwords: boolean;
  workspaces: boolean;
  handleForm: { handle: string; error: string } | null;
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
  passkeyForm: { name: string; current: string; error: string } | null;
  /** This browser can make passkeys and Portico serves the passkey module: Add passkey shows. */
  passkeysSupported: boolean;
  accountError: string;
  busy: string | null;
}
