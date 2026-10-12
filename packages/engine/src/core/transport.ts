// File: packages/engine/src/core/transport.ts
//
// What an engine adapter gives the core.  Each adapter speaks to one
// running Agda and turns its envelope into the same events: one Agda
// response at a time, and the end of each command at a boundary the
// adapter has verified for its protocol (the language server's
// `ResponseEnd`; the prompt `JSON> ` Agda prints before it reads the next
// command).  The core sends one command at a time and never infers an end
// from silence or a timer.  A transport that has the batch lane also
// starts a fresh Agda per verdict (`runBatch`), which the core queues with
// the lane's commands.

import type { BatchCommand } from "./outcome.js";

/** Why a lane or a feature is or is not available on an engine. */
export interface Capability {
  supported: boolean;
  /** Why not, naming the issue that adds it, when it is not. */
  reason?: string;
}

export interface Capabilities {
  /** The interaction lane: a long-lived Agda answering about a loaded
   * file; it tolerates open goals, so its answers are knowledge and never
   * a verdict. */
  interaction: Capability;
  /** The batch lane: a fresh `agda` per check, whose exit code is the
   * verdict of record. */
  batch: Capability;
}

export type TransportEvent =
  /** One of Agda's responses, as Agda's own JSON, unvalidated. */
  | { type: "response"; json: unknown }
  /** The command in flight has ended.  A transport sends one per command,
   * and none for an abort: Agda's command reader takes `Cmd_abort`, in
   * both engines.  The core ignores one that comes while it reads an
   * answer. */
  | { type: "end" }
  /** Output that is not a response: a line natively that is not JSON
   * (Agda prints `cannot read: ...` for a command it cannot parse), or a
   * message the language server refused. */
  | { type: "noise"; text: string }
  /** Agda is gone: exited, crashed, or was killed. */
  | { type: "exit"; code: number | null; signal?: string | null; detail?: string };

export interface EngineTransport {
  /** "browser" for Agda compiled to WebAssembly in a worker, "native" for
   * a child process. */
  readonly engine: "browser" | "native";
  readonly capabilities: Capabilities;

  /** Listen for events; the transport delivers them in order. */
  subscribe(listener: (event: TransportEvent) => void): () => void;

  /** Send one command line (an IOTCM).  The core sends the next only after
   * the previous one's end. */
  send(line: string): void;

  /** Send `Cmd_abort` out of band: Agda's command reader takes it while a
   * command runs, and that command then ends with `DoneAborting`.  It
   * produces no end of its own. */
  abort(line: string): void;

  /** The path Agda knows a file by, for a path relative to the project's
   * root. */
  resolvePath(relative: string): string;

  /** Write a source where Agda will read it (the drive; a file under the
   * project's root). */
  writeSource(path: string, text: string): Promise<void>;

  /** Read a source as Agda would, or undefined when there is none. */
  readSource(path: string): Promise<string | undefined>;

  /** Stop Agda now and release everything the transport holds (the
   * worker; the child, by a kill ladder; any batch run).  Resolves once it
   * is gone. */
  terminate(): Promise<void>;

  /** Start a fresh Agda on `path` (the batch lane), with the same
   * executable, arguments and directory as the interaction lane's.  Only a
   * transport whose `capabilities.batch` is supported has it. */
  runBatch?(path: string): BatchHandle;
}

/** A batch run in progress. */
export interface BatchHandle {
  /** What ran. */
  readonly command: BatchCommand;
  /** The run's process id, where it has one. */
  readonly pid?: number;
  /** Settles once the run's Agda is gone, however it ended; never rejects
   * (a start that fails is a run with `startError`). */
  readonly done: Promise<BatchRun>;
  /** Stop the run's Agda (its process group, by a kill ladder); resolves
   * once it is gone. */
  stop(): Promise<void>;
}

/** How a batch run ended, as the transport saw it; the session reads it
 * into a verdict. */
export interface BatchRun {
  /** Agda's exit code, or null when a signal ended it. */
  exitCode: number | null;
  signal?: string | null;
  /** Why it could not be started, when it could not. */
  startError?: string;
  /** Its standard output (all of it, or its last part when it was long),
   * and the last of its standard error. */
  stdout: string;
  stderr: string;
  /** When the standard output was too long to keep whole, its first part,
   * in whole lines; `stdout` is then its last part, in whole lines, and
   * `omitted` counts the characters between them that were not kept. */
  stdoutHead?: string;
  omitted?: number;
  elapsedMs: number;
}
