import { describe, expect, test } from "bun:test";
import { ASSISTANT_DESCRIPTIONS, JOIN_CODE_HOURS, machineSlug, NetworkService, slugify } from "../src/core/network";
import { hashSecret } from "../src/core/tokens";
import { ASSISTANT_KINDS } from "../src/core/types";
import { openDb } from "../src/db";
import { NetworkStore } from "../src/network-store";
import { addSession, errorCode, HOUR, testClock, testConfig } from "./helpers";

function makeNetwork() {
  const db = openDb(":memory:");
  const network = new NetworkStore(db);
  const clock = testClock();
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  let counter = 0;
  const networkService = new NetworkService({
    store: network,
    config: testConfig(),
    now: clock.now,
    newId: () => `id-${++counter}`,
    log: (msg, fields) => logs.push({ msg, fields }),
  });
  return { db, network, networkService, clock, logs };
}

describe("join codes", () => {
  test("a code redeems once, creating a machine whose token is stored only as a hash", () => {
    const { networkService, network, db, clock, logs } = makeNetwork();
    const { code, expiresAt } = networkService.createJoinCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAt).toBe(new Date(clock.now().getTime() + 24 * HOUR).toISOString());
    expect(JOIN_CODE_HOURS).toBe(24);
    const { machine, token } = networkService.redeemJoinCode(code, "MacBook-Pro.local");
    expect(machine.name).toBe("macbook-pro");
    expect(token).toMatch(/^bm_[A-Za-z0-9_-]{43}$/);
    expect(network.machineByTokenHash(hashSecret(token))?.id).toBe(machine.id);
    const everything = JSON.stringify([db.query("SELECT * FROM machines").all(), db.query("SELECT * FROM join_codes").all()]);
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(token);
    expect(errorCode(() => networkService.redeemJoinCode(code, "other"))).toBe("not_found");
    expect(logs).toContainEqual({ msg: "machine_joined", fields: { machine: "macbook-pro" } });
    expect(JSON.stringify(logs)).not.toContain(code);
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  test("a code expires after 24 hours", () => {
    const { networkService, clock } = makeNetwork();
    const early = networkService.createJoinCode().code;
    const late = networkService.createJoinCode().code;
    clock.advance(24 * HOUR - 1);
    expect(networkService.redeemJoinCode(early, "macbook").machine.name).toBe("macbook");
    clock.advance(2);
    expect(errorCode(() => networkService.redeemJoinCode(late, "studio"))).toBe("not_found");
    expect(() => networkService.redeemJoinCode(late, "studio")).toThrow(
      "The join code is invalid, expired or already used. Ask for a new join line.",
    );
  });

  test("an unknown code is not_found; a malformed one or a non-string machine name is bad_request", () => {
    const { networkService } = makeNetwork();
    expect(errorCode(() => networkService.redeemJoinCode("AAAAAAAAAAAAAAAAAAAAAA", "macbook"))).toBe("not_found");
    for (const bad of [undefined, null, 42, "short", "has spaces in the code", "x".repeat(65), "bad/characters+here"]) {
      expect(errorCode(() => networkService.redeemJoinCode(bad, "macbook"))).toBe("bad_request");
    }
    const { code } = networkService.createJoinCode();
    for (const bad of [undefined, null, 42, { name: "macbook" }]) {
      expect(errorCode(() => networkService.redeemJoinCode(code, bad))).toBe("bad_request");
    }
    // A refused machine name leaves the code usable.
    expect(networkService.redeemJoinCode(code, "macbook").machine.name).toBe("macbook");
  });

  test("machine names are slugged and deduplicated with -2", () => {
    const { networkService } = makeNetwork();
    const first = networkService.redeemJoinCode(networkService.createJoinCode().code, "macbook");
    const second = networkService.redeemJoinCode(networkService.createJoinCode().code, "MacBook.local");
    expect([first.machine.name, second.machine.name]).toEqual(["macbook", "macbook-2"]);
    expect(first.token).not.toBe(second.token);
    expect(networkService.listMachines().map((m) => m.name)).toEqual(["macbook", "macbook-2"]);
  });
});

describe("assistants", () => {
  test("creating one mints a ba_ token stored as a hash, with the kind's default description", () => {
    const { networkService, network, db, logs } = makeNetwork();
    const { assistant, token } = networkService.createAssistant({ name: "chatgpt", kind: "chatgpt" });
    expect(token).toMatch(/^ba_[A-Za-z0-9_-]{43}$/);
    expect(assistant).toMatchObject({ name: "chatgpt", kind: "chatgpt", owner: "owner", description: ASSISTANT_DESCRIPTIONS.chatgpt });
    expect(ASSISTANT_DESCRIPTIONS.chatgpt.length).toBeGreaterThan(0);
    expect(network.assistantByTokenHash(hashSecret(token))?.name).toBe("chatgpt");
    expect(JSON.stringify(db.query("SELECT * FROM assistants").all())).not.toContain(token);
    expect(JSON.stringify(logs)).not.toContain(token);
    const described = networkService.createAssistant({ name: "helper", kind: "other", description: "  Reads the docs  " });
    expect(described.assistant.description).toBe("Reads the docs");
    expect(networkService.createAssistant({ name: "blank", kind: "codex", description: " " }).assistant.description).toBe(
      ASSISTANT_DESCRIPTIONS.codex,
    );
    expect(errorCode(() => networkService.createAssistant({ name: "wordy", kind: "other", description: "x".repeat(501) }))).toBe(
      "bad_request",
    );
    expect(errorCode(() => networkService.createAssistant({ name: "odd", kind: "other", description: 7 }))).toBe("bad_request");
  });

  test("names follow the agent-name rule and can't reuse a bridge.yaml agent or another assistant", () => {
    const { networkService } = makeNetwork();
    expect(errorCode(() => networkService.createAssistant({ name: "Muse!", kind: "muse" }))).toBe("bad_request");
    expect(errorCode(() => networkService.createAssistant({ name: 42, kind: "muse" }))).toBe("bad_request");
    expect(errorCode(() => networkService.createAssistant({ name: "grok-bot", kind: "grok-bot" }))).toBe("bad_request");
    networkService.createAssistant({ name: "chatgpt", kind: "chatgpt" });
    expect(errorCode(() => networkService.createAssistant({ name: "chatgpt", kind: "chatgpt" }))).toBe("bad_request");
    expect(networkService.listAssistants().map((a) => a.name)).toEqual(["chatgpt"]);
  });

  test("kind must be one of the assistant kinds", () => {
    const { networkService } = makeNetwork();
    for (const kind of ["gemini", "claude-code", "", undefined, 3]) {
      expect(errorCode(() => networkService.createAssistant({ name: "helper", kind }))).toBe("bad_request");
    }
    for (const kind of ASSISTANT_KINDS) {
      expect(networkService.createAssistant({ name: `a-${kind}`, kind }).assistant.kind).toBe(kind);
    }
  });

  test("removing one deletes it", () => {
    const { networkService, network } = makeNetwork();
    const { token } = networkService.createAssistant({ name: "chatgpt", kind: "chatgpt" });
    expect(networkService.removeAssistant("chatgpt")).toBe(true);
    expect(networkService.listAssistants()).toEqual([]);
    expect(network.assistantByTokenHash(hashSecret(token))).toBeNull();
    expect(networkService.removeAssistant("chatgpt")).toBe(false);
  });
});

test("removing a machine deletes its sessions and returns their addresses", () => {
  const { networkService, network } = makeNetwork();
  const { token } = networkService.redeemJoinCode(networkService.createJoinCode().code, "macbook");
  addSession({ network }, { name: "dialog-claude", machine: "macbook" });
  addSession({ network }, { name: "api-claude", machine: "macbook" });
  addSession({ network }, { name: "dialog-claude", machine: "studio" });
  expect(networkService.removeMachine("macbook")).toEqual({
    removed: true,
    sessionAddresses: ["api-claude@macbook", "dialog-claude@macbook"],
  });
  expect(network.machineByName("macbook")).toBeNull();
  expect(network.machineByTokenHash(hashSecret(token))).toBeNull();
  expect(network.listSessions().map((s) => `${s.name}@${s.machine}`)).toEqual(["dialog-claude@studio"]);
  expect(networkService.removeMachine("macbook")).toEqual({ removed: false, sessionAddresses: [] });
});

test.each([
  ["MacBook-Pro.local", "macbook-pro"],
  ["studio", "studio"],
  ["  ", "machine"],
  ["Ünï Box", "uni-box"],
])("machineSlug(%p) is %p", (raw, slug) => expect(machineSlug(raw)).toBe(slug));

test("slugify cuts to 40 characters without a trailing hyphen, and falls back when nothing is left", () => {
  expect(slugify("Dialog App", "session")).toBe("dialog-app");
  expect(slugify("---", "session")).toBe("session");
  expect(slugify(`${"a".repeat(39)} b`, "session")).toBe("a".repeat(39));
  expect(slugify("x".repeat(60), "session")).toHaveLength(40);
});
