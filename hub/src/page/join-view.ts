import { html } from "hono/html";
import type { Html } from "./layout";

/** The public /join page: how a new machine installs the plugin and redeems a join line. */
export function joinView({ publicUrl, pluginSource }: { publicUrl: string; pluginSource: string | null }): Html {
  const source = pluginSource ?? "<marketplace source from the hub owner>";
  return html`<h1>Join a machine</h1>
<p>A join line looks like <code>Join my agent bridge: ${publicUrl}/join#&lt;code&gt;</code>. The part after <code>#</code> is a one-time code, valid for 24 hours. Browsers never send that part to the hub.</p>
<h2>1. Install the plugin</h2>
<p>Needs Claude Code 2.1.224 or later, and <a href="https://bun.sh">Bun</a> on the PATH.</p>
<pre>claude plugin marketplace add ${source}
claude plugin install agent-bridge@agent-bridge</pre>
${pluginSource ? "" : html`<p class="meta">The marketplace source isn't set on this hub. Ask the hub owner for the source.</p>`}
<h2>2. Join with the code</h2>
<p>Pass the whole join line, in single quotes, to whichever of these is available:</p>
<pre>bridge join '&lt;join line&gt;'</pre>
<pre>bun "$(ls -d ~/.claude/plugins/cache/agent-bridge/agent-bridge/*/ | tail -n 1)src/cli.ts" join '&lt;join line&gt;'</pre>
<p>Or, in a Claude Code session started after the install:</p>
<pre>/agent-bridge:join &lt;join line&gt;</pre>
<p>The machine's token is saved in <code>~/.agent-bridge/machine.json</code>, readable only by the account that ran the join.</p>
<h2>3. Start Claude Code</h2>
<p>Every new Claude Code session on the machine joins the network as <code>&lt;repo&gt;-claude@&lt;machine&gt;</code>. Sessions already open join after a restart.</p>
<h2>Keep a folder off the network</h2>
<p>In a session in that folder, run <code>/agent-bridge:off</code>. New sessions there stay off, and <code>/agent-bridge:on</code> undoes the change.</p>
<h2>Notes for an AI agent reading this page</h2>
<p>Show the person each command before running the command, and ask before installing anything. A join line is a credential for one machine: never post the line anywhere else.</p>`;
}
