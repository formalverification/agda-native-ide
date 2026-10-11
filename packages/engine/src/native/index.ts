// File: packages/engine/src/native/index.ts
//
// The native engine: `agda --interaction-json` as a child process, the
// interaction lane agda-native-air's agda-mcp runs.  This entry point is
// the engine package's only module that imports node, and only node
// resolves it (the package exports it under the `node` condition alone),
// so a browser bundle cannot take it in.
//
// The protocol has no envelope: Agda reads one command per line, writes
// one JSON response per line, and before it reads each command prints the
// prompt `JSON> ` (without a newline) from its main loop, once the
// previous command has ended (AgdaTop.hs's `repl`, at the pinned commit).
// So the first prompt says Agda is ready, and each later one ends one
// command; an aborted command ends the same way, after `DoneAborting`.
// `Cmd_abort` itself is taken by Agda's command reader and prints none.
//
// The transport owns the child and the files under the project's root.
// Its configuration is explicit: the executable, the root (the child's
// working directory, where Agda's project discovery anchors), and the
// library arguments.  Resolving the Agda and the libraries a project pins,
// and one lane per project root, are issue 64's.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  failure,
  openSession,
  type AgdaSession,
  type Capabilities,
  type EngineTransport,
  type Failure,
  type SessionOptions,
  type TransportEvent,
} from "../core/index.js";

export interface NativeConfig {
  /** The `agda` to run, by an explicit path. */
  executable: string;
  /** The project's root: the child's working directory, and the only tree
   * the transport reads or writes sources in. */
  projectRoot: string;
  /** Arguments after `--interaction-json`: the libraries, the include
   * paths, the options (for example `--no-libraries -i <root>`). */
  args?: readonly string[];
  /** The child's environment (default: this process's). */
  env?: Record<string, string | undefined>;
  /** How long Agda may take to print its first prompt, in ms. */
  startupTimeoutMs?: number;
  /** How long each step of the kill ladder waits, in ms. */
  killGraceMs?: number;
}

const PROMPT = "JSON> ";
const STDERR_TAIL = 8192;

export const nativeCapabilities: Capabilities = {
  interaction: { supported: true },
  batch: {
    supported: false,
    reason:
      "the native batch lane (a fresh agda per check, whose exit code is the verdict) is issue #64; this engine has the interaction lane only",
  },
};

export class NativeTransport implements EngineTransport {
  readonly engine = "native" as const;
  readonly capabilities = nativeCapabilities;
  readonly root: string;
  readonly child: ChildProcessWithoutNullStreams;

  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private buffer = "";
  private stderr = "";
  /** What Agda printed before its first prompt that is not a response
   * (an option it refused, say). */
  private preamble = "";
  private prompts = 0;
  private exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly exitPromise: Promise<void>;
  private readonly killGraceMs: number;
  private readonly onProcessExit: () => void;
  private readyResolve!: (ready: true | Failure) => void;
  readonly ready: Promise<true | Failure>;

  constructor(config: NativeConfig) {
    this.root = resolve(config.projectRoot);
    this.killGraceMs = config.killGraceMs ?? 2_000;
    this.ready = new Promise((resolveReady) => (this.readyResolve = resolveReady));
    this.child = spawn(config.executable, ["--interaction-json", ...(config.args ?? [])], {
      cwd: this.root,
      env: config.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so the kill ladder reaches anything it runs.
      detached: true,
    });
    this.exitPromise = new Promise((resolveExit) => {
      this.child.once("exit", (code, signal) => {
        this.exited = { code, signal };
        process.removeListener("exit", this.onProcessExit);
        this.readyResolve(
          failure("startup", `${config.executable} exited before it was ready (${signal ?? `code ${code}`})`, {
            detail: { stdout: this.preamble.trim(), stderr: this.stderr.trim() },
          }),
        );
        this.emit({
          type: "exit",
          code,
          signal,
          ...(this.stderr.trim() ? { detail: this.stderr.trim() } : {}),
        });
        resolveExit();
      });
    });
    this.child.once("error", (error) => {
      this.readyResolve(failure("startup", `${config.executable} could not be started (${error.message})`));
      if (!this.exited && this.child.pid === undefined) {
        this.exited = { code: null, signal: null };
        this.emit({ type: "exit", code: null, signal: null, detail: error.message });
      }
    });
    // Should this process end without disposing of the transport, take the
    // child with it.
    this.onProcessExit = () => this.killGroup("SIGKILL");
    process.once("exit", this.onProcessExit);

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });
    this.child.stdin.on("error", () => {
      // A write to a child that has gone: its exit says so.
    });

    const timeout = config.startupTimeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      this.readyResolve(failure("startup", `Agda printed no prompt within ${timeout} ms`, { detail: { stderr: this.stderr.trim() } }));
      void this.terminate();
    }, timeout);
    void this.ready.then(() => clearTimeout(timer));
  }

  /** The child's process id while it runs. */
  get pid(): number | undefined {
    return this.exited ? undefined : this.child.pid;
  }

  /** The last of what Agda wrote on its standard error. */
  get stderrTail(): string {
    return this.stderr;
  }

  subscribe(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(line: string): void {
    if (this.exited) throw new Error("Agda has exited");
    this.child.stdin.write(`${line}\n`);
  }

  abort(line: string): void {
    if (!this.exited) this.child.stdin.write(`${line}\n`);
  }

  resolvePath(relativePath: string): string {
    return this.inside(resolve(this.root, relativePath));
  }

  async writeSource(path: string, text: string): Promise<void> {
    const target = this.inside(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }

  async readSource(path: string): Promise<string | undefined> {
    try {
      return await readFile(this.inside(path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** End Agda: close its input, which it answers by exiting once idle;
   * then SIGTERM and SIGKILL to its process group, each after a grace
   * period. */
  async terminate(): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    if (await this.exitWithin(this.killGraceMs)) return;
    this.killGroup("SIGTERM");
    if (await this.exitWithin(this.killGraceMs)) return;
    this.killGroup("SIGKILL");
    await this.exitWithin(this.killGraceMs * 5);
  }

  private exitWithin(ms: number): Promise<boolean> {
    return new Promise((done) => {
      if (this.exited) return done(true);
      const timer = setTimeout(() => done(Boolean(this.exited)), ms);
      void this.exitPromise.then(() => {
        clearTimeout(timer);
        done(true);
      });
    });
  }

  private killGroup(signal: NodeJS.Signals) {
    if (this.exited || this.child.pid === undefined) return;
    try {
      process.kill(-this.child.pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  private inside(path: string): string {
    const absolute = resolve(this.root, path);
    const within = relative(this.root, absolute);
    if (within.startsWith("..") || isAbsolute(within))
      throw new Error(`${path} is outside the project's root, ${this.root}`);
    return absolute;
  }

  private emit(event: TransportEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private read(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      if (this.buffer.startsWith(PROMPT)) {
        this.buffer = this.buffer.slice(PROMPT.length);
        this.prompts += 1;
        if (this.prompts === 1) this.readyResolve(true);
        else this.emit({ type: "end" });
        continue;
      }
      // A prompt that has not arrived whole.
      if (this.buffer.length < PROMPT.length && PROMPT.startsWith(this.buffer)) return;
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        if (this.prompts === 0) this.preamble = (this.preamble + line + "\n").slice(-STDERR_TAIL);
        this.emit({ type: "noise", text: line });
        continue;
      }
      this.emit({ type: "response", json });
    }
  }
}

/** Start `agda --interaction-json` and wait for its first prompt. */
export async function startNativeTransport(
  config: NativeConfig,
): Promise<{ kind: "transport"; transport: NativeTransport } | Failure> {
  const transport = new NativeTransport(config);
  const ready = await transport.ready;
  if (ready === true) return { kind: "transport", transport };
  await transport.terminate();
  return ready;
}

/** Start the native engine and open a session on it. */
export async function startNativeSession(
  config: NativeConfig,
  options: SessionOptions = {},
): Promise<{ kind: "session"; session: AgdaSession; transport: NativeTransport } | Failure> {
  const started = await startNativeTransport(config);
  if (started.kind !== "transport") return started;
  const opened = await openSession(started.transport, options);
  if (opened.kind !== "session") return opened;
  return { kind: "session", session: opened.session, transport: started.transport };
}
