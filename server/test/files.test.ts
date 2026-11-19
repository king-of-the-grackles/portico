import { describe, expect, test } from "bun:test";
import { addAppAgent, addMember, addOwner, callAs, callPerson, DAY, fakeBucket, flush, HOUR, makePortico, MINUTE, PUBLIC_URL, signIn, together } from "./helpers";
import { type FileStore, uploadKey, workspaceFileKey } from "../src/core/file-store";

interface Slot {
  file: { id: string; name: string; type: string; size: number; status?: string; url: string };
  upload?: { method: string; url: string; expires_at: string };
}

async function setup(opts: { fileStore?: FileStore } = {}) {
  const p = makePortico(opts);
  const chris = await addOwner(p);
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
  const muse = addAppAgent(p, chris, "muse");
  const guarded = addAppAgent(p, chris, "guarded", { approvalRequired: true });
  const upload = async (who: { token: string }, body: unknown) => {
    const res = await callAs(p, who, "POST", "/api/agent/files", body);
    return { status: res.status, body: (await res.json()) as Slot & { error?: string; message?: string } };
  };
  const send = async (who: { token: string }, body: Record<string, unknown>) => {
    const res = await callAs(p, who, "POST", "/api/agent/messages", { subject: "Report", text: "Attached.", ...body });
    return {
      status: res.status,
      body: (await res.json()) as { message: { id: string; attachments: Slot["file"][] }; delivery: string; error?: string; message_?: string },
    };
  };
  /** The path and query of an address Portico made, for app.request. */
  const local = (url: string) => {
    expect(url.startsWith(`${PUBLIC_URL}/files/`)).toBe(true);
    return url.slice(PUBLIC_URL.length);
  };
  const task = async (who: { token: string }, id: string) =>
    (await (await callAs(p, who, "GET", `/api/agent/tasks/${id}`)).json()) as {
      messages: { id: string; withheld?: boolean; attachments?: (Slot["file"] & { download_url?: string; unavailable?: string })[] }[];
    };
  return { p, chris, grok, muse, guarded, upload, send, local, task };
}

describe("files in the data folder", () => {
  test("a text file is ready at once, travels with a message, and downloads as a download", async () => {
    const { p, grok, muse, upload, send, local, task } = await setup();
    const started = await upload(grok, { name: "notes.md", text: "# Notes\nAll good." });
    expect(started.status).toBe(201);
    expect(started.body.file).toMatchObject({ name: "notes.md", type: "text/plain", size: 17, status: "ready" });
    expect(started.body.upload).toBeUndefined();

    const sent = await send(grok, { to: "muse", attachments: [started.body.file.id] });
    expect(sent.status).toBe(201);
    expect(sent.body.message.attachments).toEqual([
      { id: started.body.file.id, name: "notes.md", type: "text/plain", size: 17, url: `${PUBLIC_URL}/api/agent/files/${started.body.file.id}` },
    ]);

    const inbox = (await (await callAs(p, muse, "GET", "/api/agent/inbox")).json()) as {
      messages: { framed_message: string; attachments: unknown[] }[];
    };
    expect(inbox.messages[0]!.attachments).toHaveLength(1);
    const framed = inbox.messages[0]!.framed_message;
    expect(framed).toContain("**Files attached (1).**");
    expect(framed).toContain("untrusted");
    expect(framed).toContain(`- notes.md (text/plain, 17 bytes), file ID \`${started.body.file.id}\``);

    const read = await task(muse, sent.body.message.id);
    const link = read.messages[0]!.attachments![0]!.download_url!;
    const res = await p.app.request(local(link));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Notes\nAll good.");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toStartWith('attachment; filename="notes.md"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");

    // The file's own address checks the token, then sends the caller on.
    const own = await callAs(p, muse, "GET", `/api/agent/files/${started.body.file.id}`);
    expect(own.status).toBe(302);
    expect((await p.app.request(local(own.headers.get("location")!))).status).toBe(200);
  });

  test("bytes go to the upload address: exactly the size stated, once", async () => {
    const { p, grok, upload, send, local } = await setup();
    const started = await upload(grok, { name: "data.bin", type: "application/x-thing", size: 5 });
    expect(started.body.file.status).toBe("uploading");
    const url = local(started.body.upload!.url);

    // Not attachable until the bytes arrive.
    const early = await send(grok, { to: "muse", attachments: [started.body.file.id] });
    expect(early.status).toBe(400);

    expect((await p.app.request(url, { method: "PUT", body: "1234" })).status).toBe(400);
    expect((await p.app.request(url, { method: "PUT", body: "123456" })).status).toBe(413);
    const put = await p.app.request(url, { method: "PUT", body: "12345" });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ file: { status: "ready", size: 5 } });
    // A finished upload can't be replaced.
    expect((await p.app.request(url, { method: "PUT", body: "54321" })).status).toBe(409);
    expect(p.files.upload(started.body.file.id)!.checksum).toBe(new Bun.CryptoHasher("sha256").update("12345").digest("hex"));

    expect((await send(grok, { to: "muse", attachments: [started.body.file.id] })).status).toBe(201);
  });

  test("an address works only as signed, for its own use, and for 15 minutes", async () => {
    const { p, grok, upload, local } = await setup();
    const started = await upload(grok, { name: "a.bin", size: 3 });
    const url = local(started.body.upload!.url);
    expect((await p.app.request(url.replace(/sig=.{4}/, "sig=0000"), { method: "PUT", body: "abc" })).status).toBe(404);
    // An upload address is no download address.
    expect((await p.app.request(url)).status).toBe(404);
    p.clock.advance(15 * MINUTE + 1);
    expect((await p.app.request(url, { method: "PUT", body: "abc" })).status).toBe(404);
  });

  test("checks the name, the size, the count and the storage caps", async () => {
    const { p, chris, grok, muse, upload, send } = await setup();
    expect((await upload(grok, { name: "../etc/passwd", text: "x" })).status).toBe(400);
    expect((await upload(grok, { name: "a.txt" })).status).toBe(400);
    expect((await upload(grok, { name: "a.txt", size: 100 * 1024 * 1024 + 1 })).status).toBe(413);
    expect((await upload(grok, { name: "a.txt", text: "x".repeat(100 * 1024 + 1) })).status).toBe(413);
    expect((await upload(grok, { name: "a.txt", type: "not a type", text: "x" })).status).toBe(400);

    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await upload(grok, { name: `f${i}.txt`, text: "x" })).body.file.id);
    expect((await send(grok, { to: "muse", attachments: ids })).status).toBe(400);
    expect((await send(grok, { to: "muse", attachments: ids.slice(0, 5) })).status).toBe(201);
    expect((await send(grok, { to: "muse", attachments: ["nope"] })).status).toBe(400);

    // Uploads no message carries yet count together from the moment each starts, so parallel uploads can't pass the cap.
    p.db.run("UPDATE uploads SET size = 5 * 1024 * 1024 * 1024 - 10 WHERE id = ?", [ids[5]!]);
    expect((await upload(muse, { name: "big.bin", size: 11 })).status).toBe(413);
    expect((await upload(muse, { name: "ok.bin", size: 4 })).status).toBe(201);
    p.db.run("UPDATE uploads SET size = 1 WHERE id = ?", [ids[5]!]);

    // Each workspace has a storage cap of its own, checked as a file is attached: a send past the cap is refused whole.
    const personal = p.content.for(p.workspaces.personal(chris.id).id).db;
    personal.run("UPDATE files SET size = 5 * 1024 * 1024 * 1024 - 10 WHERE id = ?", [ids[0]!]);
    const big = (await upload(muse, { name: "big.txt", text: "x".repeat(11) })).body.file.id;
    const small = (await upload(muse, { name: "small.txt", text: "x".repeat(4) })).body.file.id;
    const before = personal.query("SELECT COUNT(*) AS n FROM messages").get();
    expect((await send(muse, { to: "grok", attachments: [big] })).status).toBe(413);
    expect(personal.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual(before);
    expect((await send(muse, { to: "grok", attachments: [small] })).status).toBe(201);
  });

  test("a held message's files are the owner's to see first, and go when the message is declined", async () => {
    const { p, chris, grok, guarded, upload, send, task } = await setup();
    const file = (await upload(grok, { name: "plan.txt", text: "the plan" })).body.file;
    const sent = await send(grok, { to: "guarded", attachments: [file.id] });
    expect(sent.body.delivery).toBe("held");

    // The receiver sees nothing yet: not the message, not the file.
    expect((await task(guarded, sent.body.message.id)).messages).toBeUndefined();
    expect((await callAs(p, guarded, "GET", `/api/agent/files/${file.id}`)).status).toBe(404);

    // The card lists the file, and the owner can download before deciding.
    const cards = (await (await callPerson(p, signIn(p, chris), "GET", "/api/approvals")).json()) as { held: { files: unknown[] }[] };
    expect(cards.held[0]!.files).toEqual([{ id: file.id, name: "plan.txt", type: "text/plain", size: 8 }]);
    const download = await callPerson(p, signIn(p, chris), "GET", `/api/files/${file.id}`);
    expect(download.status).toBe(302);

    p.approvals.decide(chris.id, sent.body.message.id, "deny");
    await flush();
    await flush();
    // The workspace's copy and the upload it came from are both gone.
    expect(p.files.forPerson(chris, file.id)).toBeNull();
    expect(p.files.upload(file.id)).toBeNull();
    expect((await p.app.request(download.headers.get("location")!.slice(PUBLIC_URL.length))).status).toBe(404);
  });

  test("once allowed, the receiver downloads, and can pass the file on without uploading again", async () => {
    const { p, chris, grok, muse, guarded, upload, send, task } = await setup();
    const file = (await upload(grok, { name: "plan.txt", text: "the plan" })).body.file;
    const sent = await send(grok, { to: "guarded", attachments: [file.id] });
    // An agent that never received the file can't attach it.
    expect((await send(muse, { to: "grok", attachments: [file.id] })).status).toBe(400);
    expect((await send(guarded, { to: "muse", attachments: [file.id] })).status).toBe(400);

    p.approvals.decide(chris.id, sent.body.message.id, "allow_once");
    expect((await task(guarded, sent.body.message.id)).messages[0]!.attachments![0]!.download_url).toBeString();

    const passed = await send(guarded, { to: "muse", attachments: [file.id] });
    expect(passed.status).toBe(201);
    expect((await callAs(p, muse, "GET", `/api/agent/files/${file.id}`)).status).toBe(302);
  });

  test("a retry with the same key attaches nothing twice, and different files are a different message", async () => {
    const { p, grok, upload, send } = await setup();
    const a = (await upload(grok, { name: "a.txt", text: "a" })).body.file.id;
    const b = (await upload(grok, { name: "b.txt", text: "b" })).body.file.id;
    const first = await send(grok, { to: "muse", key: "k1", attachments: [a] });
    const again = await send(grok, { to: "muse", key: "k1", attachments: [a] });
    expect(again.body.message.id).toBe(first.body.message.id);
    expect(p.files.of(p.messages.require({ agent: grok.agent.id }, first.body.message.id))).toHaveLength(1);
    expect((await send(grok, { to: "muse", key: "k1", attachments: [a, b] })).status).toBe(409);
    expect((await send(grok, { to: "muse", key: "k1" })).status).toBe(409);
  });

  test("a retry stays safe after a declined message's files went", async () => {
    const { p, chris, grok, upload, send } = await setup();
    const a = (await upload(grok, { name: "a.txt", text: "a" })).body.file.id;
    const first = await send(grok, { to: "guarded", key: "k2", attachments: [a] });
    p.approvals.decide(chris.id, first.body.message.id, "deny");
    await flush();
    await flush();
    const again = await send(grok, { to: "guarded", key: "k2", attachments: [a] });
    expect(again.status).toBe(201);
    expect(again.body.message.id).toBe(first.body.message.id);
  });

  test("one agent can't hold the storage cap with files never sent", async () => {
    const { muse, grok, upload } = await setup();
    for (let i = 0; i < 10; i++) expect((await upload(grok, { name: `f${i}.bin`, size: 100 * 1024 * 1024 })).status).toBe(201);
    expect((await upload(grok, { name: "more.bin", size: 100 * 1024 * 1024 })).status).toBe(429);
    expect((await upload(muse, { name: "mine.txt", text: "x" })).status).toBe(201);
  });

  test("an address with an absurd expiry is just a bad address", async () => {
    const { p } = await setup();
    expect((await p.app.request("/files/x?exp=100000000000000000000&sig=a")).status).toBe(404);
  });

  test("a member downloads only files to and from the member's own agents", async () => {
    const { p, grok, upload, send } = await setup();
    const maya = await addMember(p);
    const hers = addAppAgent(p, maya, "maya-muse");
    const file = (await upload(grok, { name: "a.txt", text: "a" })).body.file.id;
    await send(grok, { to: "muse", attachments: [file] });
    expect((await callPerson(p, signIn(p, maya), "GET", `/api/files/${file}`)).status).toBe(404);
    together(p, grok.agent, hers.agent);
    await send(grok, { to: "maya/maya-muse", attachments: [file] });
    expect((await callPerson(p, signIn(p, maya), "GET", `/api/files/${file}`)).status).toBe(302);
    expect(hers.agent.ownerId).toBe(maya.id);
  });

  test("a file no message carries goes after an hour, and an attached one with the history", async () => {
    const { p, chris, grok, upload, send } = await setup();
    const loose = (await upload(grok, { name: "loose.txt", text: "x" })).body.file.id;
    const kept = (await upload(grok, { name: "kept.txt", text: "y" })).body.file.id;
    await send(grok, { to: "muse", attachments: [kept] });
    p.clock.advance(HOUR - MINUTE);
    expect(await p.sweepFiles()).toBe(0);
    p.clock.advance(2 * MINUTE);
    expect(await p.sweepFiles()).toBe(1);
    expect(p.files.forAgent(grok.agent, loose)).toBeNull();
    expect(p.files.forAgent(grok.agent, kept)).toMatchObject({ workspaceId: p.workspaces.personal(chris.id).id, source: null });

    p.clock.advance(31 * DAY);
    p.messages.expireDue();
    p.sweepDaily();
    expect(await p.sweepFiles()).toBe(1);
    expect(p.files.forAgent(grok.agent, kept)).toBeNull();
    expect(p.files.upload(kept)).toBeNull();
  });

  test("create_upload and attachments work over MCP", async () => {
    const { p, grok, muse } = await setup();
    const call = async (who: { token: string }, name: string, args: unknown) =>
      (await (
        await callAs(p, who, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      ).json()) as { result: { content: { text: string }[]; isError: boolean } };
    const made = await call(grok, "create_upload", { name: "r.csv", type: "text/csv", text: "a,b\n1,2\n" });
    expect(made.result.isError).toBe(false);
    expect(made.result.content[1]!.text).toContain("ready");
    const file = (JSON.parse(made.result.content[0]!.text) as Slot).file;
    const sent = await call(grok, "send_message", { to: "muse", subject: "CSV", text: "See file.", attachments: [file.id] });
    expect(sent.result.isError).toBe(false);
    const inbox = await call(muse, "check_inbox", {});
    expect(inbox.result.content[0]!.text).toContain("r.csv (text/csv, 8 bytes)");
    const bytes = await call(grok, "create_upload", { name: "big.bin", size: 2048 });
    expect(bytes.result.content[1]!.text).toContain("PUT");
  });
});

/** Copies in the bucket fail from here on, as when storage is down. Returns the working copy, to put back. */
function down(bucket: ReturnType<typeof fakeBucket>): FileStore["copy"] {
  const copy = bucket.store.copy;
  bucket.store.copy = async () => {
    throw new Error("storage down");
  };
  return copy;
}

describe("files in a bucket", () => {
  test("upload and download addresses go straight to the bucket, and the size is checked at send", async () => {
    const bucket = fakeBucket();
    const { p, chris, grok, muse, upload, send, task } = await setup({ fileStore: bucket.store });
    const started = await upload(grok, { name: "big.bin", size: 4 });
    const id = started.body.file.id;
    expect(started.body.upload!.url).toBe(`https://bucket.example/uploads/${id}?upload=900`);
    expect(p.files.takesUploads).toBe(false);

    // Nothing uploaded yet.
    expect((await send(grok, { to: "muse", attachments: [id] })).status).toBe(400);
    bucket.put(uploadKey(id), "abcd");
    const sent = await send(grok, { to: "muse", attachments: [id] });
    expect(sent.status).toBe(201);
    await flush();

    // The bytes were copied under the workspace's own prefix, and downloads come from there.
    const own = workspaceFileKey(p.workspaces.personal(chris.id).id, id);
    expect(new TextDecoder().decode(bucket.objects.get(own))).toBe("abcd");
    const read = await task(muse, sent.body.message.id);
    expect(read.messages[0]!.attachments![0]!.download_url).toBe(`https://bucket.example/${own}?download=big.bin&for=900`);
    // Portico's own /files routes carry nothing for a bucket.
    expect((await p.app.request(`/files/${started.body.file.id}?exp=1&sig=x`)).status).toBe(404);
  });

  test("an upload of the wrong size is dropped", async () => {
    const bucket = fakeBucket();
    const { p, grok, upload, send } = await setup({ fileStore: bucket.store });
    const started = await upload(grok, { name: "big.bin", size: 4 });
    bucket.put(uploadKey(started.body.file.id), "abcdefgh");
    expect((await send(grok, { to: "muse", attachments: [started.body.file.id] })).status).toBe(400);
    expect(p.files.upload(started.body.file.id)).toBeNull();
    expect(bucket.objects.has(uploadKey(started.body.file.id))).toBe(false);
  });

  test("bytes swapped after the send are never handed out", async () => {
    const bucket = fakeBucket();
    const { p, chris, grok, muse, upload, send, task } = await setup({ fileStore: bucket.store });
    const started = await upload(grok, { name: "big.bin", size: 4 });
    const id = started.body.file.id;
    bucket.put(uploadKey(id), "abcd");
    const sent = await send(grok, { to: "muse", attachments: [id] });
    await flush();
    // The upload address still works for a few minutes: the sender swaps the bytes. The workspace has its own copy by
    // then, which no address writes to.
    bucket.put(uploadKey(id), "evil");
    const own = workspaceFileKey(p.workspaces.personal(chris.id).id, id);
    const read = await task(muse, sent.body.message.id);
    expect(read.messages[0]!.attachments![0]!.download_url).toStartWith(`https://bucket.example/${own}?`);
    expect(new TextDecoder().decode(bucket.objects.get(own))).toBe("abcd");
  });

  test("bytes swapped before the copy into the workspace went through are never handed out, nor copied", async () => {
    const bucket = fakeBucket();
    const { p, chris, grok, muse, upload, send, task } = await setup({ fileStore: bucket.store });
    const copy = down(bucket);
    const started = await upload(grok, { name: "big.bin", size: 4 });
    const id = started.body.file.id;
    bucket.put(uploadKey(id), "abcd");
    const sent = await send(grok, { to: "muse", attachments: [id] });
    await flush();
    bucket.put(uploadKey(id), "evil");
    const read = await task(muse, sent.body.message.id);
    expect(read.messages[0]!.attachments![0]!.download_url).toBeUndefined();
    expect(read.messages[0]!.attachments![0]!.unavailable).toContain("changed after the upload finished");
    expect((await callAs(p, muse, "GET", `/api/agent/files/${id}`)).status).toBe(409);
    // Storage is back: the sweep's retry finds the bytes changed and copies nothing.
    bucket.store.copy = copy;
    await p.sweepFiles();
    expect(bucket.objects.has(workspaceFileKey(p.workspaces.personal(chris.id).id, id))).toBe(false);
    expect((await callAs(p, muse, "GET", `/api/agent/files/${id}`)).status).toBe(409);
  });

  test("a copy that didn't go through is finished by the sweep, and the file reads from the upload until then", async () => {
    const bucket = fakeBucket();
    const { p, chris, grok, muse, upload, send } = await setup({ fileStore: bucket.store });
    const copy = down(bucket);
    const started = await upload(grok, { name: "big.bin", size: 4 });
    const id = started.body.file.id;
    bucket.put(uploadKey(id), "abcd");
    await send(grok, { to: "muse", attachments: [id] });
    await flush();
    const own = workspaceFileKey(p.workspaces.personal(chris.id).id, id);
    expect(p.files.forAgent(muse.agent, id)).toMatchObject({ source: uploadKey(id) });
    expect((await callAs(p, muse, "GET", `/api/agent/files/${id}`)).headers.get("location")).toStartWith(`https://bucket.example/${uploadKey(id)}?`);
    // An upload a workspace still reads from outlives its day.
    p.clock.advance(2 * DAY);
    await p.sweepFiles();
    expect(p.files.upload(id)).not.toBeNull();
    bucket.store.copy = copy;
    await p.sweepFiles();
    expect(p.files.upload(id)).toBeNull();
    expect(p.files.forAgent(muse.agent, id)).toMatchObject({ source: null });
    expect(bucket.objects.has(own)).toBe(true);
    expect((await callAs(p, muse, "GET", `/api/agent/files/${id}`)).headers.get("location")).toStartWith(`https://bucket.example/${own}?`);
  });

  test("bytes swapped just before the upload address stops working are caught after it has", async () => {
    const bucket = fakeBucket();
    const { p, grok, muse, upload, send } = await setup({ fileStore: bucket.store });
    down(bucket);
    const started = await upload(grok, { name: "big.bin", size: 4 });
    bucket.put(uploadKey(started.body.file.id), "abcd");
    await send(grok, { to: "muse", attachments: [started.body.file.id] });
    p.clock.advance(14 * MINUTE);
    bucket.put(uploadKey(started.body.file.id), "evil");
    p.clock.advance(5 * MINUTE);
    expect((await callAs(p, muse, "GET", `/api/agent/files/${started.body.file.id}`)).status).toBe(409);
  });

  test("an untouched upload is checked one last time after the upload address stops working, then never again", async () => {
    const bucket = fakeBucket();
    const { p, grok, muse, upload, send } = await setup({ fileStore: bucket.store });
    down(bucket);
    const started = await upload(grok, { name: "big.bin", size: 4 });
    bucket.put(uploadKey(started.body.file.id), "abcd");
    await send(grok, { to: "muse", attachments: [started.body.file.id] });
    p.clock.advance(20 * MINUTE);
    expect((await callAs(p, muse, "GET", `/api/agent/files/${started.body.file.id}`)).status).toBe(302);
    expect(p.files.upload(started.body.file.id)!.uploadExpiresAt).toBeNull();
    let stats = 0;
    const stat = bucket.store.stat;
    bucket.store.stat = (key) => {
      stats++;
      return stat(key);
    };
    expect((await callAs(p, muse, "GET", `/api/agent/files/${started.body.file.id}`)).status).toBe(302);
    expect(stats).toBe(0);
  });

  test("storage that can't be reached marks the file unavailable, and the task still reads", async () => {
    const bucket = fakeBucket();
    const { grok, muse, upload, send, task } = await setup({ fileStore: bucket.store });
    down(bucket);
    const started = await upload(grok, { name: "big.bin", size: 4 });
    bucket.put(uploadKey(started.body.file.id), "abcd");
    const sent = await send(grok, { to: "muse", attachments: [started.body.file.id] });
    await flush();
    bucket.store.stat = async () => {
      throw new Error("network");
    };
    const read = await task(muse, sent.body.message.id);
    expect(read.messages[0]!.attachments![0]!.unavailable).toContain("couldn't reach file storage");
  });
});
