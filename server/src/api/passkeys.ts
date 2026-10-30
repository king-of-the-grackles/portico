import { Hono } from "hono";
import { type Passkey, passkeyRp } from "../core/accounts";
import type { Core } from "../core/core";
import { type PersonEnv, currentPerson } from "./context";
import { jsonObject, setPasskeyChallenge, takePasskeyChallenge } from "./session";
import type { PasskeyView } from "./views";

export function passkeyView(passkey: Passkey): PasskeyView {
  return { id: passkey.id, name: passkey.name, createdAt: passkey.createdAt, lastUsedAt: passkey.lastUsedAt };
}

/**
 * /api/passkeys: the signed-in person's own passkeys: list, add (options, which need the current password, then the
 * browser's answer) and remove.
 */
export function passkeyRoutes(core: Core): Hono<PersonEnv> {
  const { passkeys } = core.accounts;
  const route = new Hono<PersonEnv>();

  route.get("/", (c) => {
    const me = currentPerson(c);
    return c.json({ passkeys: passkeys.list(me.id).map(passkeyView) });
  });

  // A session alone can't add a way to sign in that outlives it: the challenge is issued only after the current password.
  route.post("/options", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    await core.accounts.confirmPassword(me.id, body.current);
    const options = await passkeys.registrationOptions(me, passkeyRp(core.settings.publicUrl()));
    setPasskeyChallenge(c, core, "add", options.challenge, me.id);
    return c.json({ options });
  });

  route.post("/", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    const challenge = takePasskeyChallenge(c, core, "add", me.id);
    const passkey = await passkeys.add(me, passkeyRp(core.settings.publicUrl()), {
      challenge,
      credential: body.credential,
      name: body.name,
    });
    core.changes.emit("me");
    return c.json({ passkey: passkeyView(passkey) }, 201);
  });

  route.delete("/:id", (c) => {
    const me = currentPerson(c);
    passkeys.remove(me.id, c.req.param("id"));
    core.changes.emit("me");
    return c.body(null, 204);
  });

  return route;
}
