// File: packages/engine/src/native/registry.ts
//
// One interaction lane per project root, kept alive between requests, with
// the persistence rules of agda-native-air's lane (its interaction lane
// note, § 3), as follows:
//
//   +  a registry per resolved root: the host resolves each request's file
//      to a root and an Agda (./resolve.ts), on every request, and the
//      root keys the lane; a resolution that changes (another Agda, other
//      arguments) replaces the root's lane;
//   +  requests serialized per lane: a request holds its lane from the
//      moment it ensures its file is loaded until its own operations end,
//      so no other request's load can come between;
//   +  ensure-loaded by stamp: the file is loaded only when the lane holds
//      no file or another one, or the file's text is not the text Agda's
//      live state reflects (the session's snapshot), or the file's last
//      load failed, or the request asks; the stamp is the text itself, so
//      a rewrite that keeps the size and the modification time counts;
//   +  a crash is surfaced once: the request it interrupts fails with the
//      session's failure, and the host is told of the lane's end (once,
//      whether it was busy or idle); the next request starts a new lane;
//   +  an idle lane is closed after a bound (fifteen minutes, as air's) by
//      closing its standard input, which Agda answers by exiting, code 0;
//   +  every lane is closed at disposal, and the registry refuses from then
//      on; a lane that was starting is closed as it comes up.
//
// The batch lane rides the same lanes: a verdict is queued in its root's
// session (AgdaSession.checkFile), so it never runs beside a load of the
// same checkout.  air sent `Cmd_show_version` after every command as a
// frame; this engine ends a command at Agda's prompt (ADR 0003 § 3).

import { resolve } from "node:path";

import {
  failure,
  refusal,
  type AgdaSession,
  type Answer,
  type Failure,
  type LoadValue,
  type Refusal,
  type SessionOptions,
} from "../core/index.js";
import { startNativeSession, type NativeTransport } from "./transport.js";

/** A root's lane, as the host resolved it for a file. */
export interface LaneConfig {
  /** The project's root: the lane's working directory, and the only tree
   * it reads or writes. */
  root: string;
  /** The `agda` to run, by an absolute path. */
  executable: string;
  /** Its arguments (after `--interaction-json`; before the file in a batch
   * run). */
  args: readonly string[];
  /** Its environment (default: this process's). */
  env?: Record<string, string | undefined>;
}

/** Whether a request loaded its file, and why, in air's words: `reused`
 * (nothing loaded), `first` (the lane held no file), `switch` (it held
 * another), `changed` (the file is not Agda's text), `retry` (its last load
 * failed), `requested` (the request asked). */
export type LoadReason = "reused" | "first" | "switch" | "changed" | "retry" | "requested";

/** What a request holds while it runs. */
export interface LaneUse {
  session: AgdaSession;
  transport: NativeTransport;
  root: string;
  /** The lane's Agda's process id. */
  pid: number | undefined;
  /** Whether this request started the lane's Agda. */
  spawned: boolean;
}

/** A request's lane, with its file loaded. */
export interface FileUse extends LaneUse {
  load: LoadReason;
  /** The load's answer, when one ran. */
  loaded?: Answer<LoadValue>;
}

/** A lane that ended, as the host is told. */
export interface LaneEnded {
  root: string;
  pid: number | undefined;
  /** `idle` and `disposed`: the registry closed it; `replaced`: its
   * resolution changed; `crashed`: Agda exited, or a deadline stopped it,
   * on its own account. */
  reason: "idle" | "crashed" | "disposed" | "replaced";
  /** The session's account of its end. */
  detail?: Record<string, unknown>;
  /** How its Agda exited, for a lane the registry closed: code 0 when it
   * ended at the end of its input. */
  exit?: { code: number | null; signal: string | null };
}

export interface LaneRegistryOptions {
  /** A file's root and Agda, or why it has none; asked on every request. */
  resolve(path: string): Promise<LaneConfig | Refusal | Failure> | LaneConfig | Refusal | Failure;
  /** How long a lane may sit idle before it is closed, in ms (default
   * fifteen minutes). */
  idleMs?: number;
  /** Every session's options.  `expandQuestionMarks` defaults to false
   * here: a lane loads files as they are on disk, and a `?` recorded as
   * `{!  !}` would make the snapshot differ from the file, and every
   * request load again. */
  session?: SessionOptions;
  /** How long Agda may take to print its first prompt, in ms. */
  startupTimeoutMs?: number;
  /** How long each step of a kill ladder waits, in ms. */
  killGraceMs?: number;
  /** Told once of each lane's end. */
  onLaneEnded?(ended: LaneEnded): void;
}

interface Lane {
  root: string;
  key: string;
  session: AgdaSession;
  transport: NativeTransport;
  pid: number | undefined;
  /** Why the registry closed it, when it did. */
  closing?: LaneEnded["reason"];
  reported: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface Slot {
  /** The last request in this root's line; each waits for the one before. */
  tail: Promise<void>;
  /** Requests that hold or wait for the lane. */
  holders: number;
  lane?: Lane;
}

const DEFAULT_IDLE_MS = 15 * 60_000;

const keyOf = (config: LaneConfig) =>
  JSON.stringify([config.executable, config.args, Object.entries(config.env ?? {}).sort()]);

function isConfig(value: LaneConfig | Refusal | Failure): value is LaneConfig {
  return !("kind" in value);
}

export class LaneRegistry {
  private readonly slots = new Map<string, Slot>();
  /** Lanes being started, each settling only once its lane is registered
   * or, the registry having closed meanwhile, closed. */
  private readonly starting = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly options: LaneRegistryOptions) {}

  /** The lanes that run now. */
  lanes(): Array<{ root: string; pid: number | undefined; busy: boolean }> {
    return [...this.slots.entries()].flatMap(([root, slot]) =>
      slot.lane ? [{ root, pid: slot.lane.pid, busy: slot.holders > 0 }] : [],
    );
  }

  /** Run `use` with the lane of `path`'s root, loading nothing (a verdict
   * needs no load). */
  withLane<T>(path: string, use: (lane: LaneUse) => Promise<T>): Promise<T | Refusal | Failure> {
    return this.hold(path, (lane, spawned) => use(this.useOf(lane, spawned)));
  }

  /** Run `use` with the lane of `path`'s root, with the file loaded as it
   * is on disk unless Agda's live state already reflects it. */
  withFile<T>(
    path: string,
    use: (file: FileUse) => Promise<T>,
    options: { reload?: boolean } = {},
  ): Promise<T | Refusal | Failure> {
    return this.hold(path, async (lane, spawned) => {
      let text: string | undefined;
      try {
        text = await lane.transport.readSource(path);
      } catch (error) {
        return failure("io", `${path} could not be read in its lane, rooted at ${lane.root} (${String(error)})`);
      }
      if (text === undefined) return failure("io", `there is no source at ${path}`);
      const reason = loadReason(lane.session, path, text, options.reload ?? false);
      let loaded: Answer<LoadValue> | undefined;
      if (reason !== "reused") {
        const load = await lane.session.load(path);
        if (load.kind !== "answer") return load;
        loaded = load;
      }
      return use({ ...this.useOf(lane, spawned), load: reason, ...(loaded ? { loaded } : {}) });
    });
  }

  /** Close every lane, and refuse from now on. */
  async dispose(): Promise<void> {
    this.closed = true;
    const closing = [...this.slots.values()].flatMap((slot) => (slot.lane ? [this.close(slot, slot.lane, "disposed")] : []));
    await Promise.all(closing);
    await Promise.allSettled([...this.starting]);
  }

  private useOf(lane: Lane, spawned: boolean): LaneUse {
    return { session: lane.session, transport: lane.transport, root: lane.root, pid: lane.pid, spawned };
  }

  private async hold<T>(
    path: string,
    work: (lane: Lane, spawned: boolean) => Promise<T | Refusal | Failure>,
  ): Promise<T | Refusal | Failure> {
    if (this.closed) return refusal("session-ended", "the lanes are closed");
    let config: LaneConfig | Refusal | Failure;
    try {
      config = await this.options.resolve(path);
    } catch (error) {
      return failure("startup", `the lane for ${path} could not be resolved (${String(error)})`);
    }
    if (!isConfig(config)) return config;
    if (this.closed) return refusal("session-ended", "the lanes are closed");
    const root = resolve(config.root);
    let slot = this.slots.get(root);
    if (!slot) {
      slot = { tail: Promise.resolve(), holders: 0 };
      this.slots.set(root, slot);
    }
    slot.holders += 1;
    if (slot.lane?.idleTimer) {
      clearTimeout(slot.lane.idleTimer);
      slot.lane.idleTimer = undefined;
    }
    let release!: () => void;
    const turn = new Promise<void>((done) => (release = done));
    const before = slot.tail;
    slot.tail = before.then(() => turn);
    await before;
    try {
      if (this.closed) return refusal("session-ended", "the lanes are closed");
      const key = keyOf(config);
      let lane = slot.lane;
      if (lane && lane.session.status.state === "ended") {
        this.ended(slot, lane);
        lane = undefined;
      }
      if (lane && lane.key !== key) {
        await this.close(slot, lane, "replaced");
        lane = undefined;
      }
      let spawned = false;
      if (!lane) {
        const started = await this.start(root, key, config);
        if ("kind" in started) return started;
        lane = started;
        slot.lane = lane;
        spawned = true;
      }
      return await work(lane, spawned);
    } finally {
      slot.holders -= 1;
      release();
      this.arm(slot);
    }
  }

  /** Start a root's lane; once it is up, a registry closed meanwhile closes
   * it, and the request is refused. */
  private start(root: string, key: string, config: LaneConfig): Promise<Lane | Refusal | Failure> {
    const starting = (async (): Promise<Lane | Refusal | Failure> => {
      const started = await startNativeSession(
        {
          executable: config.executable,
          projectRoot: root,
          args: config.args,
          ...(config.env ? { env: config.env } : {}),
          ...(this.options.startupTimeoutMs !== undefined ? { startupTimeoutMs: this.options.startupTimeoutMs } : {}),
          ...(this.options.killGraceMs !== undefined ? { killGraceMs: this.options.killGraceMs } : {}),
        },
        { expandQuestionMarks: false, ...this.options.session },
      );
      if (started.kind !== "session") return started;
      if (this.closed) {
        await started.session.dispose();
        return refusal("session-ended", "the lanes were closed while this one started");
      }
      const lane: Lane = {
        root,
        key,
        session: started.session,
        transport: started.transport,
        pid: started.transport.pid,
        reported: false,
      };
      // A lane the registry did not close has crashed (or a deadline
      // stopped it); one it closes is reported once its Agda is gone.
      started.session.onStatus((status) => {
        const slot = this.slots.get(root);
        if (status.state === "ended" && !lane.closing && slot) this.ended(slot, lane);
      });
      return lane;
    })();
    this.starting.add(starting);
    return starting.finally(() => this.starting.delete(starting));
  }

  /** A lane's end, told once; the root's next request starts another. */
  private ended(slot: Slot, lane: Lane, exit?: LaneEnded["exit"]) {
    if (slot.lane === lane) slot.lane = undefined;
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    if (lane.reported) return;
    lane.reported = true;
    const detail = lane.session.ending;
    try {
      this.options.onLaneEnded?.({
        root: lane.root,
        pid: lane.pid,
        reason: lane.closing ?? "crashed",
        ...(detail ? { detail } : {}),
        ...(exit ? { exit } : {}),
      });
    } catch (error) {
      console.error("A lane listener failed:", error);
    }
  }

  private async close(slot: Slot, lane: Lane, reason: LaneEnded["reason"]) {
    lane.closing ??= reason;
    if (slot.lane === lane) slot.lane = undefined;
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    // The transport closes Agda's input first, which Agda answers by
    // exiting, code 0, when it is idle.
    await lane.session.dispose();
    const child = lane.transport.child;
    this.ended(slot, lane, { code: child.exitCode, signal: child.signalCode });
  }

  /** Close a root's lane once it has been idle for the bound. */
  private arm(slot: Slot) {
    const lane = slot.lane;
    if (!lane || slot.holders > 0 || this.closed) return;
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    lane.idleTimer = setTimeout(() => {
      if (slot.holders === 0 && slot.lane === lane) void this.close(slot, lane, "idle");
    }, this.options.idleMs ?? DEFAULT_IDLE_MS);
    lane.idleTimer.unref?.();
  }
}

/** Why a request must load its file, or `reused` when Agda's live state
 * is its text. */
export function loadReason(session: AgdaSession, path: string, text: string, requested: boolean): LoadReason {
  if (requested) return "requested";
  const basis = session.basis;
  if (!basis) return "first";
  if (basis.path !== path) return "switch";
  const plan = session.plan(path, text);
  if (plan.kind === "unchanged") return "reused";
  if (plan.kind === "load" && plan.reason === "the last load failed") return "retry";
  return "changed";
}
