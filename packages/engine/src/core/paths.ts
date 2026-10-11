// File: packages/engine/src/core/paths.ts
//
// The sources an engine loads: an Agda module, or a literate one, named by
// an absolute path in the engine's own filesystem (the drive's, in the
// page; the host's, natively).  The manifest names its modules by these
// rules.

export type SourceKind = "agda" | "lagda" | "lagda.md" | "lagda.tex" | "lagda.rst" | "lagda.org" | "lagda.typ";

const SUFFIXES: readonly [string, SourceKind][] = [
  [".lagda.md", "lagda.md"],
  [".lagda.tex", "lagda.tex"],
  [".lagda.rst", "lagda.rst"],
  [".lagda.org", "lagda.org"],
  [".lagda.typ", "lagda.typ"],
  [".lagda", "lagda"],
  [".agda", "agda"],
];

/** What kind of source a path names, from its suffix, or undefined. */
export function sourceKind(path: string): SourceKind | undefined {
  for (const [suffix, kind] of SUFFIXES) if (path.endsWith(suffix)) return kind;
  return undefined;
}

/** An absolute, normalized path to an Agda source: it starts with `/`,
 * has no empty, `.` or `..` segment, and names a source kind. */
export function isSourcePath(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("/")) return false;
  const segments = path.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return false;
  return sourceKind(path) !== undefined;
}
