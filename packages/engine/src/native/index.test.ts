// File: packages/engine/src/native/index.test.ts
//
// The native transport against small stand-ins for `agda`: node scripts
// that print what a test needs, to make output and faults a real Agda
// cannot be asked for (a line of many megabytes, a prompt in pieces, a
// start that fails without a newline).  The conformance runner drives the
// real Agda (scripts/conformance/native.mjs).

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TransportEvent } from "../core/transport.js";
import { NativeTransport, startNativeTransport } from "./index.js";

let dir: string;

/** An executable node script, as an `agda` that runs `body`. */
function fakeAgda(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "native-transport-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function started(executable: string) {
  const started = await startNativeTransport({ executable, projectRoot: dir, killGraceMs: 200 });
  if (started.kind !== "transport") throw new Error(started.message);
  const events: TransportEvent[] = [];
  started.transport.subscribe((event) => events.push(event));
  return { transport: started.transport, events };
}

const until = async (condition: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
};

describe("the native transport's reader", () => {
  it("reads a line of many megabytes in linear time", async () => {
    const megabytes = 32;
    const agda = fakeAgda(
      "big-line",
      `process.stdout.write("JSON> ");
process.stdin.once("data", async () => {
  const piece = "x".repeat(65536);
  process.stdout.write('{"kind":"HighlightingInfo","text":"');
  for (let i = 0; i < ${megabytes * 16}; i++)
    if (!process.stdout.write(piece)) await new Promise((done) => process.stdout.once("drain", done));
  process.stdout.write('"}\\nJSON> ');
});`,
    );
    const { transport, events } = await started(agda);
    const sent = performance.now();
    transport.send("IOTCM ...");
    await until(() => events.some((event) => event.type === "end"), 20_000);
    const elapsed = performance.now() - sent;
    const response = events.find((event) => event.type === "response") as { json: { text: string } } | undefined;
    expect(response?.json.text.length).toBe(megabytes * 1024 * 1024);
    // Rescanning the line with every chunk took 5.9 s here for 32 MB.
    expect(elapsed).toBeLessThan(3_000);
    await transport.terminate();
  });

  it("reads a prompt in pieces, and two prompts in one chunk", async () => {
    const agda = fakeAgda(
      "pieces",
      `process.stdout.write("JS");
setTimeout(() => process.stdout.write("ON> "), 20);
process.stdin.once("data", () => {
  process.stdout.write('{"kind":"Status"}\\nJS');
  setTimeout(() => process.stdout.write('ON> JSON> '), 20);
});`,
    );
    const { transport, events } = await started(agda);
    transport.send("IOTCM ...");
    await until(() => events.filter((event) => event.type === "end").length === 2, 2_000);
    expect(events.map((event) => event.type)).toEqual(["response", "end", "end"]);
    await transport.terminate();
  });
});

describe("the native transport's failed starts", () => {
  it("keeps the last words of an Agda that exits, unended", async () => {
    const agda = fakeAgda("refuses", `process.stdout.write("Unrecognized option: --interaction-jsn"); process.exit(1);`);
    const started = await startNativeTransport({ executable: agda, projectRoot: dir });
    expect(started).toMatchObject({ kind: "failure", reason: "startup" });
    expect(JSON.stringify(started)).toContain("Unrecognized option: --interaction-jsn");
  });

  it("names a root that is not a directory, and leaves no exit hook", async () => {
    const hooks = process.listenerCount("exit");
    const agda = fakeAgda("never-run", `process.stdout.write("JSON> ");`);
    const started = await startNativeTransport({ executable: agda, projectRoot: join(dir, "missing") });
    expect(started).toMatchObject({ kind: "failure", reason: "startup" });
    expect((started as { message: string }).message).toMatch(/the project's root, .*missing, is not a directory/);
    const missing = await startNativeTransport({ executable: join(dir, "no-such-agda"), projectRoot: dir });
    expect((missing as { message: string }).message).toMatch(/no-such-agda could not be started/);
    expect(process.listenerCount("exit")).toBe(hooks);
  });
});

describe("the native transport's root", () => {
  it("takes a name that begins with two dots, and refuses a parent", async () => {
    const agda = fakeAgda("idle", `process.stdout.write("JSON> "); process.stdin.resume();`);
    const transport = new NativeTransport({ executable: agda, projectRoot: dir, killGraceMs: 200 });
    expect(transport.resolvePath("..x.agda")).toBe(join(dir, "..x.agda"));
    expect(() => transport.resolvePath("../x.agda")).toThrow(/outside the project's root/);
    expect(() => transport.resolvePath("..")).toThrow(/outside the project's root/);
    await transport.terminate();
  });
});
