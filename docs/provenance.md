<!-- File: docs/provenance.md -->

# Provenance

Where every file this repository took from elsewhere comes from, what became
of it here, and the license it ships under.  The imported tree and the pinned
binaries are recorded file by file, with their SHA-256s.  [`NOTICE`][notice]
names everything the built site ships, with its license, and
[`licenses/`][licenses] holds the texts; ADR 0001 records the decisions
behind this shape.

## Upstream

+  **Repository**: [SeungheonOh/plfa-playground][upstream], MIT (its license
   is kept verbatim as [`LICENSE.plfa-playground`][upstream-license]).
+  **Commit**: `ae0aa84c24363a8d6dadc292b6eb8f88f7f38705`, by Seungheon Oh,
   2026-08-31 20:50 -0500 (2026-09-01 in UTC), "Use the official Agda mark
   for the favicon": the head of upstream's `master` on 2026-10-04, when it
   was imported.
+  **How**: a snapshot, not a history merge.  The commit "Import
   plfa-playground at ae0aa84c, without its binaries" holds 89 of upstream's
   128 files, byte for byte, and none of upstream's history.
+  **The records**, in [`upstream/`][records]:
   +  `plfa-playground.sha256`: every file of upstream's tree at that commit,
      with its SHA-256, exactly as `scripts/upstream-record.sh <commit>`
      prints it;
   +  `unchanged.sha256`: the imported files that are still upstream's, byte
      for byte, at their paths here (`make provenance-check` verifies them);
   +  `assets.sha256`: the pinned binaries, which the flake fetches and
      `make assets-check` verifies.

The README's "Syncing with upstream" uses these records to bring in a later
upstream commit.

## What became of each upstream file

| Upstream path | Here | Why |
|---|---|---|
| `README.md` | `README.plfa-playground.md`, unchanged | This repository has its own README. |
| `LICENSE` | `LICENSE.plfa-playground`, unchanged | This repository's `LICENSE` is William DeMeo's; it names upstream's. |
| `.github/workflows/ci.yml` | `.github/workflows/app.yml`, changed, then removed | This repository's `ci.yml` lints the plan; `site.yml` replaced it ([#5]). |
| `.gitignore` | not imported | Its lines are merged into this repository's `.gitignore`. |
| `wrangler.jsonc` | not imported | Upstream's Cloudflare account and route; hosting is [#6]. |
| `NOTICE.md` | imported, then removed | `NOTICE` supersedes it and carries its text verbatim. |
| 35 binaries under `static/` | not imported; pinned | Fetched by hash ([below](#pinned-binaries)). |
| `static/agda-data.zip` | not imported; pinned, then replaced | Upstream's held Agda 2.7.0.1's builtin library, which the shipped Agda rejects; the flake builds one instead ([below](#agdas-builtin-library-built-here), [#49]). |
| `static/als-2.8ext.wasm.gz` | not imported; not pinned | The build makes its own ([below](#the-compilers-gzip)). |
| every other file (85) | same path, unchanged unless listed below | Listed in `upstream/unchanged.sha256`. |

Every change made here to an imported file is listed under [Changes to
upstream files](#changes-to-upstream-files), and a file that can carry a
comment says so in a header naming the upstream file and commit.

## Pinned binaries

The flake fetches each file from
`https://raw.githubusercontent.com/SeungheonOh/plfa-playground/ae0aa84c24363a8d6dadc292b6eb8f88f7f38705/<path>`,
one fixed-output fetch per file, by the SHA-256 in `upstream/assets.sha256`,
so a fetched file that differs by a byte fails the fetch.  `make assets`
copies the set into `static/`, and `make build` checks every file there
against the same SHA-256 before it builds.  The 35 files total 48,642,786
bytes.  Each group below says where upstream got the files (checked
2026-10-04) and their license.

### The compiler

The Agda Language Server compiled to WASI, with Agda's JSON interaction mode.
Upstream built it from pinned sources with `compiler/build-agda-wasm.sh`
(agda-web/agda-language-server `e65419f89e3152c2922e948b3e4d24580172bc6a`,
agda-web/agda `e2f8c69414fa115328280ecc4de1d2b7a23be7fa`, ghc-wasm-meta
`c3f44696d29aaeadd755d69c51735954bfcd59db` with the 9.10 flavour, which is
GHC 9.10.3.20250924), and `compiler/README.md` records the same SHA-256.
These bytes were committed in upstream's `8a03ddaf` (2026-08-31) and are
unchanged at `ae0aa84c`.  They are not a release asset of any repository
([#4]), so upstream's git tree is the one source; a mirror and a rebuild
are [#4]'s open half.

The binary statically links the language server (MIT), Agda (MIT), GHC's
runtime and boot libraries (the Glasgow Haskell Compiler License), GMP 6.3.0
(LGPL-3.0-or-later or GPL-2.0-or-later), and the Hackage packages of its build
plan.

| Path | Bytes | SHA-256 |
|---|---:|---|
| `static/als-2.8ext.wasm` | 32,996,332 | `53c62b0ad569a9d123f744b192c13780c494ade0cddef4daaa00db41ecd7f7a1` |

### The standard library

The Agda standard library 2.3, sources only.  Its 1,391 files are agda/agda-stdlib
`v2.3`'s, entry for entry (equal CRC-32s against GitHub's archive of the
tag); upstream repacked them with 642 directory entries, an empty
`_build/2.8.0/agda/src/` tree among them.  License: MIT, carried in the
archive as `agda-stdlib-2.3/LICENCE`, identical to the tag's.

| Path | Bytes | SHA-256 |
|---|---:|---|
| `static/agda-stdlib-2.3.zip` | 1,997,897 | `7468c113272425ce3223a33b233a31c7e90ae0758cdb1538584be6560bc86cf0` |

### JuliaMono

The JuliaMono 0.060 web fonts, byte-identical to `webfonts/` in
[cormullion/juliamono] at tag `v0.060` (commit
`5908c8613863806b3f053859e35049780c9c4784`), the Latin subsets included.
License: SIL Open Font License 1.1, with Reserved Font Name JuliaMono; the
fonts carry the notice in their metadata, and `licenses/juliamono.txt`
carries the license text.

| Path | Bytes | SHA-256 |
|---|---:|---|
| `static/JuliaMono-Bold.woff2` | 1,037,992 | `91b10c2fabdada8552b9d774dbc80a0ec3459238af265af7bc421246fb9f7af8` |
| `static/JuliaMono-BoldItalic.woff2` | 1,086,692 | `327b8fa8cc789a68694a92b33cdfa4ce8557b74d04041e33d179e2b5fb0fdcbc` |
| `static/JuliaMono-BoldLatin.woff2` | 28,776 | `7a89ae8c9d793aa45afd00896bbfebd1c52a8eadeefffdd4615047e9ad98126d` |
| `static/JuliaMono-Regular.woff2` | 1,038,424 | `3ce46801cd7d8b181f3ed792111afef2ef23fed42ebbaf1279a5cad55dc0708d` |
| `static/JuliaMono-RegularItalic.woff2` | 1,087,352 | `14a4aa0a860d60aacf3be59038915fceccc8e93a6d48e42d458b0244fb69c70b` |
| `static/JuliaMono-RegularLatin.woff2` | 27,644 | `b6246bb7c907f1bdc165f8642aa1a776387c8a9d47d85e05e388ea274f3bf9f3` |

### The favicon

Upstream's 128-pixel raster of its `static/favicon.svg`, which adapts Agda's
official mark, `doc/user-manual/agda.svg` in [agda/agda] (designed by Miëtek
Bak, adopted in Agda 2.6.1).  The mark ships in the Agda package as one of its
`extra-doc-files`, under the package's MIT license; agda/agda states no other
terms for it, and no trademark policy.  License: MIT (Agda's, and
upstream's for the adaptation).

| Path | Bytes | SHA-256 |
|---|---:|---|
| `static/favicon.png` | 3,276 | `11e142dff8309670762d34d7bedb718c8172267c20e95ebbf25ada02abf489e1` |

### PLFA

*Programming Language Foundations in Agda*, from [plfa/plfa.github.io] at
`870f9bb12d61927cdea3311cedcbbc48ac3fc422` (2026-08-21), as upstream's
scripts package it: `project.zip` holds the chapters' sources,
`plfa.agda-lib` and upstream's two adapter modules (`plfa/browser/*.agda`;
`scripts/sync-plfa.mjs`), and each interface archive holds the Agda 2.8.0
interfaces of one chapter's closure, the standard-library modules it imports
among them (`scripts/precompile-plfa.mjs`).  License: CC BY 4.0 for PLFA
(`static/plfa/LICENSE`, identical to the book's `LICENSE` at that commit);
MIT for the standard library's interfaces and for upstream's adapters.
Removing PLFA is [#20].

| Path | Bytes | SHA-256 |
|---|---:|---|
| `static/plfa/project.zip` | 220,347 | `7425dcef3ae92fcfda2d4b583abe4d52d1ff420ac84de5545af7b10be1f6c5ac` |
| `static/plfa/interfaces/part1/Connectives.zip` | 130,099 | `22c5c51c070e7c4646606155e080344fa35055edc2268ca23f1f68ca55b42c6f` |
| `static/plfa/interfaces/part1/Decidable.zip` | 106,475 | `d997769a7d6eb436eee193969c61bf0a2fdbf79e754926f9d2c46de219e09295` |
| `static/plfa/interfaces/part1/Equality.zip` | 74,401 | `25e01d4daa7d267ef7f592e60363699c9da679d62e63ea5943e7265f384741f6` |
| `static/plfa/interfaces/part1/Induction.zip` | 93,709 | `8182378c6efc86c199016a19cb5700720ca13ecb65fa756f3a0ffc531dea43bb` |
| `static/plfa/interfaces/part1/Isomorphism.zip` | 85,476 | `0f4ebee903ee7abb133b7eddf8b30ce19f231fc109920476be5b33e24843f1fc` |
| `static/plfa/interfaces/part1/Lists.zip` | 176,356 | `582cb09195af2304b515d22d3df7d36486f8ef12a6e732513f56570f7aefab06` |
| `static/plfa/interfaces/part1/Naturals.zip` | 2,410,017 | `f6c56f7cd39d3fb0043aa672329d72d405abae86f0458ea2d20a31c337e058db` |
| `static/plfa/interfaces/part1/Negation.zip` | 399,290 | `4ba68b802d4cee11b15b145f7a07e3dc7a798e7fe33877328183ec46436f427b` |
| `static/plfa/interfaces/part1/Quantifiers.zip` | 87,482 | `dbf96928c086d2690b1d9a2c899f1d6457fd9a87489f182b3acc4a4a87c0a423` |
| `static/plfa/interfaces/part1/Relations.zip` | 110,045 | `a2c4c568ef0dc405e6e6f1f20f4f9ef09acadcc23f8873cca8550756a5129623` |
| `static/plfa/interfaces/part2/BigStep.zip` | 135,406 | `c059a3a643225d14d91ccc8cfff0abb3c5f25cc06db3413aadac133799ecd6b2` |
| `static/plfa/interfaces/part2/Bisimulation.zip` | 98,296 | `51491dfac864bddc4c8227f6635e7531de6fd8ffcea39525415aec354dbc0e70` |
| `static/plfa/interfaces/part2/Confluence.zip` | 162,932 | `9fc55a393d1221522d4e6e83080b9c8890b2e305d94f65f7a37a023bb3155c6f` |
| `static/plfa/interfaces/part2/DeBruijn.zip` | 174,849 | `9a3fbb95a136f6f0d7520c3723f55beb0ba51d72c9df03378b63928d4783da6c` |
| `static/plfa/interfaces/part2/Inference.zip` | 232,730 | `fd8063b448b43cd44eae67a65d68cac9d3647250f05d21b8b57c8cc959418faf` |
| `static/plfa/interfaces/part2/Lambda.zip` | 2,275,060 | `02a67ba070a00d8e31cf27b975d2738ed8fd606f2d45ec3ee62f2492a5467221` |
| `static/plfa/interfaces/part2/More.zip` | 246,118 | `47e61cfb16b1a2a3d53d3ef692147fffd2f25902ae0261b186079587653eca87` |
| `static/plfa/interfaces/part2/Properties.zip` | 244,700 | `7048c751a59c247adc6038934c23d7baa11e963567655be9e506e20f277458a2` |
| `static/plfa/interfaces/part2/Substitution.zip` | 243,384 | `dc3c17d3b5883ec0d67a17ab8f67994d78e435673d8b6f110c3990b808c8c234` |
| `static/plfa/interfaces/part2/Untyped.zip` | 145,052 | `b78c74984e2c81c4789dcef66afa39d7474c8938a93022e1ea63d7ab274fcce0` |
| `static/plfa/interfaces/part3/Adequacy.zip` | 305,750 | `f838f18ada51f109db278e146791c027ea4a5ae01a1d6e80fa7be7ed1a952bad` |
| `static/plfa/interfaces/part3/Compositional.zip` | 154,696 | `5dfc518d2ab399e07a9401fc7d16ee5d115df98d5fc2269fdd74ebf002e4ce52` |
| `static/plfa/interfaces/part3/ContextualEquivalence.zip` | 49,886 | `78d08b2342f872d9b710475effa9bb65085b8ff4d23d54b9022aa867d7afeafc` |
| `static/plfa/interfaces/part3/Denotational.zip` | 704,375 | `c4c8f8ad5ecdedeed6557e8a35b0a84e48be498ea65bd35a1b51be8dc7026987` |
| `static/plfa/interfaces/part3/Soundness.zip` | 271,470 | `c725f51822615c4f60e52a5948fd4fb692d0cb47ad6e3ecadfb3be610df28f82` |

## Agda's builtin library, built here

`static/agda-data.zip` is Agda's `lib/prim`, whole: the sources of the
`Agda.Primitive` and `Agda.Builtin` modules, `agda-builtins.agda-lib`, and
the interfaces of every module under `_build/<version>/agda/`.  The flake
builds it (`nix build .#agda-data`, `mkAgdaData` in `flake.nix`) from the
Agda of its pinned nixpkgs, `haskellPackages.Agda` 2.8.0 at nixpkgs
`b6018f87da91d19d0ab4cf979885689b469cdd41`, as follows:

+  that Agda writes its own data files into a throwaway data directory
   (`agda --setup`), and builds its `lib/prim` in place there (`agda
   --build-library`), naming no other library and no option;
+  the whole directory goes into the archive at the root the page's server
   reads it from, `lib/prim` (the server is built without Agda's
   `use-xdg-data-home` flag, and `src/lib/worker/als.ts` sets
   `Agda_datadir` to `/`);
+  the zip is stored, its entries sorted, and every entry dated
   1980-01-01, so its bytes depend on the input alone: `nix build
   .#agda-data --rebuild` finds no difference, where the same build with
   the files' own times fails it.

`agdaDataInput` in `flake.nix` names the input, the Agda and the root;
[#58]'s move to another Agda changes it, and nothing else.  The Agda must
be the one the page's server embeds, since an interface is accepted only
by the Agda version that wrote it, and the server writes its own copy of
the sources before it starts.  On 2026-10-06 the archive held 73 entries:
36 sources, 36 interfaces (header version 202507030) and the library file.
License: Agda's (MIT), as of v2.8.0 (`licenses/agda-builtins.txt`, Agda's
`LICENSE` at that tag).

| Path | Bytes | SHA-256 |
|---|---:|---|
| `static/agda-data.zip` | 681,730 | `37063713ccc641ee11f30895ddee4542e24b1529e55f22aa85a8dfddbb875203` |

Upstream's archive, a pin until [#49] replaced it, held Agda 2.7.0.1's
`lib/prim`: 37 sources, 37 interfaces of header version 202406290, which
Agda 2.8.0 rejects and checks again, and `agda-builtins.agda-lib`.  It was
byte-identical to `static/agda-data.zip` of [agda-web/als-demo] (branch
`public`, last changed in `291b135bec22e976e0e018609fc34dc8e0898267`,
2025-10-09): 591,281 bytes, SHA-256
`27d81d0987fa692e4a811851b23e5cd9e28b01d11f0ea3b30ee35be309259ea3`.

## The compiler's gzip

Upstream commits `static/als-2.8ext.wasm.gz` (10,188,407 bytes, SHA-256
`ea79dbb12144db68ef7aeb56bdebc10c143d76d3a3af89056276d4015cb2b32f`), and it
is not pinned here, because nothing needs it:

+  `npm run build` writes its own: `scripts/prepare-cloudflare-assets.mjs`
   gzips the raw compiler in `build/` (node's zlib at level 9) and deletes the
   raw copy.  On 2026-10-04 that gzip was 10,154,917 bytes and inflated to
   the pinned compiler's SHA-256.
+  `npm run dev` falls back to the raw compiler.  With no `.gz` in `static/`,
   the dev server answered the `.gz` with a 404, the page fetched
   `als-2.8ext.wasm` instead, and Agda started and checked `Main.agda` (two
   open goals, cross-origin isolated; headless Chrome 153, 2026-10-04).

## Third-party files among the imported text

These came in with the import; they are text, so they are in git, unchanged.

| Path | Origin | License |
|---|---|---|
| `static/coi-serviceworker.js` | Byte-identical to [gzuidhof/coi-serviceworker] at `509a799daa6583b83b2a70b4dd1898c7e5a902dd` (2023-12-05), the sixth commit to the file after the v0.1.7 release, whose version its header still names | MIT, Copyright (c) 2021 Guido Zuidhof |
| `static/plfa/content/**/*.lagda.md` | PLFA's chapters at `870f9bb1` (`scripts/sync-plfa.mjs`) | CC BY 4.0 |
| `static/plfa/LICENSE` | Byte-identical to plfa/plfa.github.io's `LICENSE` at `870f9bb1` | The CC BY 4.0 text |
| `static/favicon.svg` | Upstream's adaptation of agda/agda's `doc/user-manual/agda.svg` (its own comment says so) | MIT |
| `src/`, `scripts/`, the rest | Upstream's own code; its `NOTICE.md` says the WASI worker, the virtual filesystem, the highlighting, the input method and the transport began from [agda-web/als-demo], whose `LICENSE` is byte-identical to upstream's | MIT |

## Changes to upstream files

Each change is its own commit, named here by its subject.

| File | Change | Commit |
|---|---|---|
| `.github/workflows/app.yml` (upstream's `ci.yml`) | Installs Nix, materializes the pinned binaries (`make assets`) and builds with `make build`; uses the dev shell's node; runs on pushes to `main`; the deploy job removed (hosting is [#6]) | "Build the app workflow from the pinned binaries" |
| `.github/workflows/app.yml` | Removed: `.github/workflows/site.yml` replaces it, with its npm steps as `make test` and `make check` and its build as `nix build .#site` ([#5]) | "Check Main.agda in headless Chromium, in CI" |
| `package.json` | The `deploy` script (`npm run build && wrangler deploy`) removed.  JSON carries no comment, so this row is the record. | "Remove the deploy script from package.json" |
| `package.json`, `package-lock.json` | The `wrangler` dev dependency removed, with the 84 other lockfile entries only it brought in (`workerd`, `miniflare`, `sharp`, `undici`, and `esbuild`, which vite takes only as an optional peer).  The lockfile is upstream's with those 85 entries deleted, nothing else re-resolved, and the built site is byte-identical ([#3]).  JSON carries no comment, so this row is the record. | "Remove wrangler, and the packages only it brings in" |
| `package-lock.json` | `devalue` 5.9.2 to 5.9.4, the newest release inside SvelteKit's and Svelte's `^5.8.1`, which fixes the six advisories npm audit reported against it; only its entry changed.  The page does not bundle `devalue`, so the built site is byte-identical ([#3]). | "Update devalue to 5.9.4" |
| `svelte.config.js` | `kit.version.name` is `SITE_REVISION`, the source revision the Makefile and the flake pass in, rather than the time of the build, so that two builds of one commit are identical ([#3]) | "Name the build by its source revision" |
| `vite.config.js` | The commit a build records is `SITE_REVISION` when it is set, before falling back to `git describe`, which finds no `.git` in the Nix sandbox ([#3]) | "Name the build by its source revision" |
| `src/lib/controller.svelte.ts` | The `?cache=` tokens of the compiler's, the standard library's and PLFA's project URLs, the compiler's length in bytes (`32_996_332`), and the drive's cache namespace (a string naming the PLFA commit) come from `src/lib/assets.ts`, which the build derives from the files (`scripts/asset-manifest.mjs`), instead of being maintained by hand; `agda-data.zip`'s URL, which had no token, gains one ([#3]) | "Derive the cache tokens, the compiler's length and the cache namespace" |
| `src/routes/+page.svelte` | The `?cache=` token of PLFA's interface manifest and archives comes from `src/lib/assets.ts` instead of being maintained by hand ([#3]) | "Derive the cache tokens, the compiler's length and the cache namespace" |
| `vite.config.js` | Defines `AGDA_ASSETS` for `src/lib/assets.ts`: the cache tokens, the compiler's length and the drive's cache namespace, which `scripts/asset-manifest.mjs` derives from the files in `static/`; a build hook refuses to build without them, while the dev server, vitest and svelte-check run without them ([#3]) | "Derive the cache tokens, the compiler's length and the cache namespace" |
| `NOTICE.md` | Removed; `NOTICE` names everything the site ships and quotes it in full (its section 1) | "Remove upstream's NOTICE.md, which NOTICE supersedes" |
| `src/lib/worker/drive.ts` | The drive's root directory answers its lookups from an index of the drive's paths (`src/lib/worker/drive-index.ts`), built once the drive is constructed and kept in step with Agda's calls and with the drive worker's own writes (message types 3 and 4), instead of scanning every key per lookup; Runno's methods still compute every result ([#50]) | "Index the drive's lookups" |
| `src/lib/worker/drive.ts` | Agda's builtin library is extracted as it comes: the callback that moved its interfaces under `lib/prim/_build/2.8.0/agda/` is removed, since the flake builds the archive with them already there, under the building Agda's own version ([#49]) | "Build agda-data.zip from an Agda's own lib/prim" |

[upstream]: https://github.com/SeungheonOh/plfa-playground
[upstream-license]: ../LICENSE.plfa-playground
[records]: ../upstream/
[notice]: ../NOTICE
[licenses]: ../licenses/
[#3]: https://github.com/formalverification/agda-native-ide/issues/3
[#4]: https://github.com/formalverification/agda-native-ide/issues/4
[#5]: https://github.com/formalverification/agda-native-ide/issues/5
[#6]: https://github.com/formalverification/agda-native-ide/issues/6
[#20]: https://github.com/formalverification/agda-native-ide/issues/20
[#49]: https://github.com/formalverification/agda-native-ide/issues/49
[#50]: https://github.com/formalverification/agda-native-ide/issues/50
[#58]: https://github.com/formalverification/agda-native-ide/issues/58
[agda-web/als-demo]: https://github.com/agda-web/als-demo
[agda/agda]: https://github.com/agda/agda
[cormullion/juliamono]: https://github.com/cormullion/juliamono
[plfa/plfa.github.io]: https://github.com/plfa/plfa.github.io
[gzuidhof/coi-serviceworker]: https://github.com/gzuidhof/coi-serviceworker
