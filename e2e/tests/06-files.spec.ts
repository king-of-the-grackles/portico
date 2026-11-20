// A file goes from one person's agent to another's, is downloaded, and is passed on into another Portico.
import { randomBytes } from "node:crypto";
import { expect, test, unique } from "../lib/fixtures";

test("a file is sent, downloaded by the receiver, and passed on into another Portico", async ({ world }) => {
  const alice = await world.person("alice");
  const shared = await world.shared();
  const probe = await world.agent("alice", "probe");
  const helper = await world.agent("alice", "helper");
  const scout = await world.agent("bob", "scout");

  // Bob's scout uploads two files: bytes PUT straight to file storage, and a small text file inside the call.
  const bytes = randomBytes(64 * 1024);
  const notes = `Notes ${unique("for the report")}\n`;
  const reportId = await scout.upload("report.bin", bytes, "application/octet-stream");
  const notesId = await scout.upload("notes.txt", notes);

  const subject = unique("The report");
  const sent = await scout.send({ to: `${alice.handle}/probe`, subject, text: "Report and notes attached.", attachments: [reportId, notesId] });
  expect(sent.portico.id).toBe(shared.id);

  // Alice's probe receives the message with both files named, and downloads the same bytes.
  const received = await probe.receive(subject);
  expect(received.attachments.map((f) => f.name)).toEqual(["report.bin", "notes.txt"]);
  expect(received.attachments[0]!.size).toBe(bytes.byteLength);
  const report = await probe.download(received.id, reportId);
  expect(report.bytes.equals(bytes)).toBe(true);
  expect((await probe.download(received.id, notesId)).bytes.toString()).toBe(notes);

  // The file's own address works with the receiver's token, and not for an agent the message never reached.
  const direct = await fetch(received.attachments[0]!.url, { headers: { Authorization: `Bearer ${probe.token}` } });
  expect(Buffer.from(await direct.arrayBuffer()).equals(bytes)).toBe(true);
  expect((await helper.raw("GET", `/files/${reportId}`)).status).toBe(404);

  // Passing on: probe names the received file in a message to helper, which goes through Alice's own Portico.
  const onward = unique("Passing the report on");
  const passed = await probe.send({ to: "helper", subject: onward, text: "From Bob's scout.", attachments: [reportId] });
  expect(passed.portico.id).not.toBe(shared.id);
  const got = await helper.receive(onward);
  expect(got.attachments.map((f) => f.id)).toEqual([reportId]);

  // The bytes are copied into that Portico's own storage after the send, so the download may take a moment to work.
  let copy!: { bytes: Buffer; url: string };
  await expect(async () => {
    copy = await helper.download(got.id, reportId);
  }).toPass({ timeout: 30_000 });
  expect(copy.bytes.equals(bytes)).toBe(true);
  // Each Portico keeps its own copy: the two download addresses differ beyond their signatures.
  expect(new URL(copy.url).pathname).not.toBe(new URL(report.url).pathname);
});
