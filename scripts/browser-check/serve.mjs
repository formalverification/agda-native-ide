// File: scripts/browser-check/serve.mjs
//
// A static server for a built site, without the two headers that make a
// page cross-origin isolated (Cross-Origin-Opener-Policy: same-origin and
// Cross-Origin-Embedder-Policy: require-corp), or with them when asked:
// the page needs neither since issue 59, and the check runs both ways, to
// show that it works with them and without.  It serves files as they are,
// a `.gz` as application/gzip with no Content-Encoding (as GitHub Pages
// does), and logs every request, since a worker's requests are invisible
// to the page's DevTools session.  A test can answer chosen paths itself,
// to see what the page does when a request fails (issue 8).  It can send
// `no-store` for chosen paths, so that every request for them reaches its
// log rather than the browser's HTTP cache: a check that no archive was
// requested must not be passed by that cache (issue 14).  Adapted from the
// 2026-10-04 investigation's harness (issue 5).
//
//   node scripts/browser-check/serve.mjs <site> [port] [--isolated]

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
  ".zip": "application/zip",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serve `root` on 127.0.0.1 (a secure context, as isolation requires),
 * with the isolation headers when `isolated`.  `answer`, when given, is
 * asked first for each request's path, and its answer, if any, is sent in
 * place of the file; with `cut`, the answer claims twice its length, and
 * the connection is dropped after its body, as a transfer that breaks off.
 * @param {{ root: string, port?: number, isolated?: boolean,
 *   answer?: (path: string) =>
 *     { status: number, body: Buffer, cut?: boolean } | undefined,
 *   noStore?: string[] }} options  `noStore`: the path prefixes sent with
 *   `cache-control: no-store` instead of `max-age=600`
 */
export function serve({ root, port = 0, isolated = false, answer, noStore = [] }) {
  // Every file must lie under this prefix; the filesystem root is its own
  // prefix, already ending in a separator.
  const resolved = resolve(root);
  const base = resolved.endsWith(sep) ? resolved : resolved + sep;
  /** @type {{ t: number, method: string, url: string, status: number, bytes: number }[]} */
  const log = [];
  const t0 = performance.now();
  const server = createServer(async (request, response) => {
    const entry = {
      t: Math.round(performance.now() - t0),
      method: request.method ?? "GET",
      url: request.url ?? "/",
      status: 0,
      bytes: 0,
    };
    log.push(entry);
    let status = 200;
    /** @type {Buffer} */
    let body = Buffer.from("");
    /** @type {string | null} */
    let file = null;
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith("/")) path += "index.html";
      file = resolve(base, "." + path);
    } catch {
      // A target no browser sends (a malformed escape, say).
      status = 400;
      body = Buffer.from("bad request");
    }
    const answered =
      file === null
        ? undefined
        : answer?.(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    if (file === null) {
      // Answered above.
    } else if (answered) {
      status = answered.status;
      body = answered.body;
    } else if (!file.startsWith(base)) {
      status = 403;
      body = Buffer.from("forbidden");
    } else {
      try {
        body = await readFile(file);
      } catch {
        status = 404;
        body = Buffer.from("not found");
      }
    }
    entry.status = status;
    entry.bytes = body.length;
    const cut = Boolean(answered?.cut);
    response.writeHead(status, {
      "content-type":
        status === 200
          ? (TYPES[extname(file ?? "")] ?? "application/octet-stream")
          : "text/plain; charset=utf-8",
      "content-length": cut ? 2 * body.length : body.length,
      "cache-control": noStore.some((prefix) => entry.url.startsWith(prefix)) ? "no-store" : "max-age=600",
      ...(isolated
        ? {
            "cross-origin-opener-policy": "same-origin",
            "cross-origin-embedder-policy": "require-corp",
          }
        : {}),
    });
    if (cut) response.write(body, () => response.destroy());
    else response.end(request.method === "HEAD" ? undefined : body);
  });
  return new Promise((done) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const listening =
        typeof address === "object" && address ? address.port : port;
      done({
        origin: `http://127.0.0.1:${listening}`,
        log,
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections();
            server.close(() => closed(undefined));
          }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const isolated = args.includes("--isolated");
  const [root, port] = args.filter((arg) => arg !== "--isolated");
  if (!root) {
    console.error(
      "usage: node scripts/browser-check/serve.mjs <site> [port] [--isolated]",
    );
    process.exit(2);
  }
  const { origin } = await serve({ root, port: Number(port ?? 8000), isolated });
  console.log(
    `serving ${root} at ${origin}/, ${isolated ? "with" : "without"} the isolation headers`,
  );
}
