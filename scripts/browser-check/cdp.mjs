// File: scripts/browser-check/cdp.mjs
//
// A minimal Chrome DevTools Protocol driver: launch headless Chromium
// with a fresh profile, attach to one tab, and evaluate in it, press keys
// and take screenshots.  node 22's global WebSocket is all the protocol
// needs, so the check runs with no npm package and no bundled browser;
// the flake pins both node and Chromium.  Adapted from the 2026-10-04
// investigation's launcher (issue 5).  The page's navigate, setViewport,
// addInitScript and onConsole are the interface ./bidi.mjs shares, so the
// check's assertions run in Firefox too (issue 59).
//
// Nothing waits for ever: every command has a time limit, and once the
// browser exits, its socket closes or the page's renderer crashes, every
// command pending or sent later fails at once.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How long one protocol command may take, in ms. */
const COMMAND_TIMEOUT_MS = 60_000;

/**
 * Launch `chrome` headless and attach to a new tab.
 * @param {string} chrome the browser's executable
 */
export async function launch(chrome) {
  const profile = mkdtempSync(join(tmpdir(), "browser-check-"));
  const browser = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      // CI's runners and the Nix build of Chromium offer no sandbox.
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const removeProfile = () => {
    // Chromium can still be writing its profile as it exits.
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // A leftover temporary directory is not worth failing over.
    }
  };

  try {
    return await attach(chrome, browser, removeProfile);
  } catch (error) {
    browser.kill();
    removeProfile();
    throw error;
  }
}

/**
 * @param {string} chrome
 * @param {import("node:child_process").ChildProcess} browser
 * @param {() => void} removeProfile
 */
async function attach(chrome, browser, removeProfile) {
  // Chromium prints its DevTools endpoint on stderr, once.
  const endpoint = await new Promise((found, failed) => {
    let stderr = "";
    const timer = setTimeout(
      () => failed(new Error(`${chrome} printed no DevTools endpoint in 30 s`)),
      30_000,
    );
    browser.stderr?.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/ws:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        found(match[0]);
      }
    });
    browser.on("error", (error) => {
      clearTimeout(timer);
      failed(new Error(`cannot start ${chrome}: ${error.message}`));
    });
    browser.on("exit", (code) => {
      clearTimeout(timer);
      failed(
        new Error(`${chrome} exited with ${code}: ${stderr.slice(0, 600)}`),
      );
    });
  });

  const session = await connect(endpoint);
  browser.once("exit", (code) =>
    session.fail(new Error(`${chrome} exited with ${code}`)),
  );
  const { product } = await session.send("Browser.getVersion");
  const { targetId } = await session.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await session.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  // A crashed renderer never answers the commands it was sent.
  const page = tab(session, sessionId);
  page.on("Inspector.targetCrashed", () =>
    session.fail(new Error("the page's renderer crashed")),
  );
  await page.send("Inspector.enable");

  return {
    product,
    page,
    async close() {
      session.close();
      const exited = new Promise((done) => browser.once("exit", done));
      browser.kill();
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
        if (message.error)
          waiting.reject(
            new Error(`${message.error.message} ${message.error.data ?? ""}`),
          );
        else waiting.resolve(message.result);
      } else if (message.method)
        for (const listener of listeners) listener(message);
    });
    socket.addEventListener("error", () => {
      failed(new Error(`cannot connect to ${url}`));
      fail(new Error("the DevTools socket failed"));
    });
    socket.addEventListener("close", () =>
      fail(new Error("the DevTools socket closed")),
    );
    socket.addEventListener("open", () =>
      connected({
        listeners,
        fail,
        close: () => socket.close(),
        /** @param {string} method @param {object} [params] @param {string} [sessionId] */
        send(method, params = {}, sessionId) {
          if (closed) return Promise.reject(closed);
          if (socket.readyState !== WebSocket.OPEN)
            return Promise.reject(new Error("the DevTools socket is not open"));
          const message = {
            id: ++id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          };
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

/** @param {any} session @param {string} sessionId */
function tab(session, sessionId) {
  const page = {
    /** @param {string} method @param {object} [params] */
    send: (method, params) => session.send(method, params, sessionId),
    /** @param {number} width @param {number} height */
    setViewport: (width, height) =>
      page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    /** Run `source` in every document before its own scripts.
     * @param {string} source */
    addInitScript: (source) =>
      page.send("Page.addScriptToEvaluateOnNewDocument", { source }),
    /** @param {string} url */
    async navigate(url) {
      await page.send("Page.enable");
      await page.send("Page.navigate", { url });
    },
    /** Call `handler` with each console message and uncaught exception.
     * @param {(entry: { type: string, text: string }) => void} handler */
    onConsole(handler) {
      page.on("Runtime.consoleAPICalled", (event) =>
        handler({
          type: event.type,
          text: event.args
            .map((/** @type {any} */ a) => a.value ?? a.description ?? "")
            .join(" ")
            .slice(0, 500),
        }),
      );
      page.on("Runtime.exceptionThrown", (event) =>
        handler({
          type: "exception",
          text: (
            event.exceptionDetails.exception?.description ??
            event.exceptionDetails.text
          ).slice(0, 500),
        }),
      );
      return page.send("Runtime.enable");
    },
    /** @param {string} method @param {(params: any) => void} handler */
    on(method, handler) {
      session.listeners.push((/** @type {any} */ message) => {
        if (message.method === method && message.sessionId === sessionId)
          handler(message.params);
      });
    },
    /** Evaluate `fn(arg)` in the page and return its (JSON) value.
     * @param {Function} fn @param {any} [arg] */
    async eval(fn, arg) {
      const { result, exceptionDetails } = await page.send("Runtime.evaluate", {
        expression: `(${fn})(${JSON.stringify(arg ?? null)})`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails)
        throw new Error(
          exceptionDetails.exception?.description ?? exceptionDetails.text,
        );
      return result.value;
    },
    /** Press a key, with modifiers (1 Alt, 2 Ctrl, 4 Meta, 8 Shift).
     * @param {string} key @param {string} code @param {number} keyCode
     * @param {number} [modifiers] */
    async press(key, code, keyCode, modifiers = 0) {
      const event = { key, code, windowsVirtualKeyCode: keyCode, modifiers };
      await page.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        ...event,
      });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    },
    /** @param {string} text */
    type: (text) => page.send("Input.insertText", { text }),
    async screenshot() {
      const { data } = await page.send("Page.captureScreenshot", {
        format: "png",
      });
      return Buffer.from(data, "base64");
    },
  };
  return page;
}
