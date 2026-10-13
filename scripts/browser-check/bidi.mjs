// File: scripts/browser-check/bidi.mjs
//
// A minimal WebDriver BiDi driver for Firefox, with the page interface of
// ./cdp.mjs (navigate, an init script, a viewport, console messages,
// evaluation, key presses, typing, a screenshot), so that the browser
// check's assertions run in Firefox too (issue 59).  Firefox speaks BiDi
// on the port --remote-debugging-port opens, and node 22's global
// WebSocket is all it needs.
//
// Nothing waits for ever: every command has a time limit, and once the
// browser exits or its socket closes, every command pending or sent later
// fails at once.  The profile is made under the home directory, since the
// Ubuntu snap's Firefox cannot read one under /tmp.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How long one protocol command may take, in ms. */
const COMMAND_TIMEOUT_MS = 60_000;

/** WebDriver's key values for the keys the check presses. */
const KEYS = /** @type {Record<string, string>} */ ({
  Escape: "",
  Home: "",
  ArrowLeft: "",
  ArrowUp: "",
  ArrowRight: "",
  ArrowDown: "",
  End: "",
  Enter: "",
  Control: "",
  Alt: "",
  Meta: "",
  Shift: "",
});

/**
 * Launch `firefox` headless and attach to its first tab.
 * @param {string} firefox the browser's executable
 */
export async function launch(firefox) {
  // Not hidden: the snap's home interface hides dot-directories.
  const profile = mkdtempSync(join(homedir(), "browser-check-firefox-"));
  const browser = spawn(
    firefox,
    [
      "--headless",
      "--no-remote",
      "--profile",
      profile,
      "--remote-debugging-port",
      "0",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  const removeProfile = () => {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // A leftover directory is not worth failing over.
    }
  };
  // The snap starts the browser under a wrapper: kill its process group.
  const kill = () => {
    try {
      if (browser.pid) process.kill(-browser.pid, "SIGTERM");
    } catch {
      browser.kill();
    }
  };

  try {
    return await attach(firefox, browser, kill, removeProfile);
  } catch (error) {
    kill();
    removeProfile();
    throw error;
  }
}

/**
 * @param {string} firefox
 * @param {import("node:child_process").ChildProcess} browser
 * @param {() => void} kill
 * @param {() => void} removeProfile
 */
async function attach(firefox, browser, kill, removeProfile) {
  // Firefox prints its BiDi endpoint on stderr, once.
  const endpoint = await new Promise((found, failed) => {
    let stderr = "";
    const timer = setTimeout(
      () => failed(new Error(`${firefox} printed no BiDi endpoint in 30 s`)),
      30_000,
    );
    browser.stderr?.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        found(match[1]);
      }
    });
    browser.on("error", (error) => {
      clearTimeout(timer);
      failed(new Error(`cannot start ${firefox}: ${error.message}`));
    });
    browser.on("exit", (code) => {
      clearTimeout(timer);
      failed(
        new Error(`${firefox} exited with ${code}: ${stderr.slice(0, 600)}`),
      );
    });
  });

  const session = await connect(`${endpoint}/session`);
  browser.once("exit", (code) =>
    session.fail(new Error(`${firefox} exited with ${code}`)),
  );
  const { capabilities } = await session.send("session.new", {
    capabilities: {},
  });
  const product = `Firefox/${capabilities.browserVersion}`;
  const { contexts } = await session.send("browsingContext.getTree", {});
  const context = contexts[0].context;
  await session.send("session.subscribe", { events: ["log.entryAdded"] });

  return {
    product,
    page: tab(session, context),
    async close() {
      await session.send("browser.close", {}).catch(() => {});
      session.close();
      const exited = new Promise((done) => browser.once("exit", done));
      kill();
      await Promise.race([
        exited,
        new Promise((done) => setTimeout(done, 3000)),
      ]);
      removeProfile();
    },
  };
}

/** @param {string} url */
function connect(url) {
  return new Promise((connected, failed) => {
    const socket = new WebSocket(url);
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
    const pending = new Map();
    /** @type {((message: any) => void)[]} */
    const listeners = [];
    let id = 0;
    /** @type {Error | null} */
    let closed = null;
    /** Fail every pending command, and every later one. @param {Error} error */
    const fail = (error) => {
      closed ??= error;
      for (const waiting of pending.values()) waiting.reject(closed);
      pending.clear();
    };
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const waiting =
        message.id === undefined ? undefined : pending.get(message.id);
      if (waiting) {
        pending.delete(message.id);
        if (message.type === "error")
          waiting.reject(new Error(`${message.error}: ${message.message}`));
        else waiting.resolve(message.result);
      } else if (message.type === "event")
        for (const listener of listeners) listener(message);
    });
    socket.addEventListener("error", () => {
      failed(new Error(`cannot connect to ${url}`));
      fail(new Error("the BiDi socket failed"));
    });
    socket.addEventListener("close", () =>
      fail(new Error("the BiDi socket closed")),
    );
    socket.addEventListener("open", () =>
      connected({
        listeners,
        fail,
        close: () => socket.close(),
        /** @param {string} method @param {object} params */
        send(method, params) {
          if (closed) return Promise.reject(closed);
          if (socket.readyState !== WebSocket.OPEN)
            return Promise.reject(new Error("the BiDi socket is not open"));
          const message = { id: ++id, method, params };
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(message.id);
              reject(
                new Error(
                  `${method} had no answer in ${COMMAND_TIMEOUT_MS / 1000} s`,
                ),
              );
            }, COMMAND_TIMEOUT_MS);
            pending.set(message.id, {
              resolve: (value) => {
                clearTimeout(timer);
                resolve(value);
              },
              reject: (error) => {
                clearTimeout(timer);
                reject(error);
              },
            });
            socket.send(JSON.stringify(message));
          });
        },
      }),
    );
  });
}

/** @param {any} session @param {string} context */
function tab(session, context) {
  /** Key actions for one source.  @param {object[]} actions */
  const keys = (actions) =>
    session.send("input.performActions", {
      context,
      actions: [{ type: "key", id: "keyboard", actions }],
    });
  const page = {
    /** @param {number} width @param {number} height */
    setViewport: (width, height) =>
      session.send("browsingContext.setViewport", {
        context,
        viewport: { width, height },
      }),
    /** Run `source` in every document before its own scripts.
     * @param {string} source */
    addInitScript: (source) =>
      session.send("script.addPreloadScript", {
        functionDeclaration: `() => { ${source} }`,
      }),
    /** @param {string} url */
    navigate: (url) =>
      session.send("browsingContext.navigate", { context, url, wait: "none" }),
    /** Call `handler` with each console message and uncaught exception.
     * @param {(entry: { type: string, text: string }) => void} handler */
    onConsole(handler) {
      session.listeners.push((/** @type {any} */ message) => {
        if (message.method !== "log.entryAdded") return;
        const { type, method, level, text } = message.params;
        handler({
          type: type === "javascript" ? "exception" : (method ?? level),
          text: String(text ?? "").slice(0, 500),
        });
      });
    },
    /** Evaluate `fn(arg)` in the page and return its (JSON) value.
     * @param {Function} fn @param {any} [arg] */
    async eval(fn, arg) {
      const result = await session.send("script.evaluate", {
        expression: `(async () => JSON.stringify(await (${fn})(${JSON.stringify(arg ?? null)})))()`,
        target: { context },
        awaitPromise: true,
        resultOwnership: "none",
      });
      if (result.type === "exception")
        throw new Error(result.exceptionDetails?.text ?? "an exception");
      const value = result.result;
      return value.type === "string" ? JSON.parse(value.value) : undefined;
    },
    /** Press a key, with modifiers (1 Alt, 2 Ctrl, 4 Meta, 8 Shift).
     * @param {string} key @param {string} _code @param {number} _keyCode
     * @param {number} [modifiers] */
    async press(key, _code, _keyCode, modifiers = 0) {
      const held = [
        [1, KEYS.Alt],
        [2, KEYS.Control],
        [4, KEYS.Meta],
        [8, KEYS.Shift],
      ]
        .filter(([bit]) => modifiers & /** @type {number} */ (bit))
        .map(([, value]) => /** @type {string} */ (value));
      const value = KEYS[key] ?? key;
      await keys([
        ...held.map((v) => ({ type: "keyDown", value: v })),
        { type: "keyDown", value },
        { type: "keyUp", value },
        ...held.reverse().map((v) => ({ type: "keyUp", value: v })),
      ]);
    },
    /** Type `text`, a newline as Enter. @param {string} text */
    type: (text) =>
      keys(
        [...text].flatMap((c) => {
          const value = c === "\n" ? KEYS.Enter : c;
          return [
            { type: "keyDown", value },
            { type: "keyUp", value },
          ];
        }),
      ),
    async screenshot() {
      const { data } = await session.send("browsingContext.captureScreenshot", {
        context,
      });
      return Buffer.from(data, "base64");
    },
  };
  return page;
}
