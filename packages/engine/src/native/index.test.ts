// File: packages/engine/src/native/index.test.ts
//
// The native transport against small stand-ins for `agda`: node scripts
// that print what a test needs, to make output and faults a real Agda
// cannot be asked for (a line of many megabytes, a prompt in pieces, a
// start that fails without a newline).  The conformance runner drives the
// real Agda (scripts/conformance/native.mjs).

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TransportEvent } from "../core/transport.js";
import { NativeTransport, startBatch, startNativeTransport } from "./index.js";

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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** An `agda` that is a lane with `--interaction-json` and runs `batch`
 * otherwise. */
function laneAndBatch(name: string, batch: string): string {
  return fakeAgda(
    name,
    `if (process.argv.includes("--interaction-json")) { process.stdout.write("JSON> "); process.stdin.resume(); }
else { ${batch} }`,
  );
}

describe("the native transport's batch runs", () => {
  it("runs the lane's Agda with its arguments and the file last, in the root, and keeps the exit code and output", async () => {
    const agda = laneAndBatch(
      "batch-echo",
      `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
process.stderr.write("on stderr\\n");
process.exitCode = 42;`,
    );
    const transport = new NativeTransport({ executable: agda, projectRoot: dir, args: ["--flag", "-i", "."], killGraceMs: 200 });
    const run = transport.runBatch(transport.resolvePath("Sub/X.agda"));
    expect(run.command).toEqual({ executable: agda, args: ["--flag", "-i", ".", join(dir, "Sub/X.agda")], cwd: dir });
    const ended = await run.done;
    expect(ended).toMatchObject({ exitCode: 42, stderr: "on stderr\n" });
    expect(JSON.parse(ended.stdout)).toEqual({ args: ["--flag", "-i", ".", join(dir, "Sub/X.agda")], cwd: dir });
    expect(() => transport.runBatch(join(dir, "../Outside.agda"))).toThrow(/outside the project's root/);
    await transport.terminate();
  });

  it("stops a run that ignores SIGTERM, and what it started, by SIGKILL to its group", async () => {
    const pidFile = join(dir, "stubborn.pids");
    const agda = fakeAgda(
      "batch-stubborn",
      `process.on("SIGTERM", () => {});
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, child: child.pid }));
setInterval(() => {}, 1000);`,
    );
    const run = startBatch({ executable: agda, args: [], cwd: dir }, process.env, 200);
    await until(() => existsSync(pidFile), 5_000);
    await until(() => readFileSync(pidFile, "utf8").endsWith("}"), 1_000);
    const { pid, child } = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; child: number };
    const started = performance.now();
    await run.stop();
    const ended = await run.done;
    expect(ended).toMatchObject({ exitCode: null, signal: "SIGKILL" });
    expect(alive(pid)).toBe(false);
    await until(() => !alive(child), 2_000);
    expect(alive(child)).toBe(false);
    // SIGTERM was ignored, so SIGKILL came one grace period later.
    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
  });

  it("stops a running batch run when the transport terminates", async () => {
    const agda = laneAndBatch("batch-sleeps", `setInterval(() => {}, 1000);`);
    const transport = new NativeTransport({ executable: agda, projectRoot: dir, killGraceMs: 200 });
    const run = transport.runBatch(transport.resolvePath("X.agda"));
    await transport.terminate();
    expect(await run.done).toMatchObject({ exitCode: null, signal: "SIGTERM" });
  });

  it("is a run that never started when its executable is missing", async () => {
    const run = startBatch({ executable: join(dir, "no-such-agda"), args: [], cwd: dir }, process.env, 200);
    const ended = await run.done;
    expect(ended).toMatchObject({ exitCode: null });
    expect(ended.startError).toMatch(/ENOENT/);
    await run.stop();
  });
});
