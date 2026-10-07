# File: flake.nix
#
# The project's dev shell, the github-project roadmap engine, and the
# binaries the app ships: pinned by hash, or built here from pinned inputs.
#
# `nix develop` puts the gh-project-* CLIs on PATH (the Makefile stub
# finds them there), and the re-exported apps allow `nix run .#update`
# directly.  Upgrade the engine deliberately with
# `nix flake update github-project`.
#
# `nix build .#assets` fetches every binary named in
# upstream/assets.sha256 from upstream's repository at the commit this
# repository imported, one fixed-output fetch per file, so a byte that
# differs from its pin fails the fetch, and adds this repository's own:
# the compiler, which `nix build .#compiler` fetches by the hashes in
# compiler/agda-2.9.0.sha256 (`nix develop .#compiler` is the dev shell
# that builds it, compiler/build-agda-2.9.0.sh); Agda's builtin library,
# agda-data.zip, which `nix build .#agda-data` builds from the compiler's
# own lib/prim (mkAgdaData, below); and the standard library, which `nix
# build .#stdlib` builds patched.  `make assets` copies the result into
# static/, and `make build` checks the files there against their pins
# before it builds.  docs/provenance.md records where each file comes
# from and its license.
#
# `nix build .#site` builds the static site: the npm dependencies are
# one fixed-output fetch of everything package-lock.json names (pinned
# by npmDepsHash), the binaries are `assets`, and the build is `make
# build`, as in the dev shell, named by this flake's source revision.
# Nothing else reaches the network, and two builds of one commit are
# identical; check with `nix build .#site --rebuild`.
{
  description = "agda-native-ide: an Agda IDE in the browser, with its pinned runtime";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  inputs.github-project.url = "github:williamdemeo/github-project";
  # The WebAssembly toolchain of the compiler (issue 58): GHC 9.10 for
  # wasm32-wasi, its cabal, binaryen and wasmtime, at the commit Agda's own
  # flake pins at the Agda commit the compiler is built from, with that
  # commit's own nixpkgs, so the store paths are the ones Agda's dev shell
  # gives (compiler/build-agda-2.9.0.sh).
  inputs.ghc-wasm-meta.url = "git+https://gitlab.haskell.org/haskell-wasm/ghc-wasm-meta.git?rev=58260711fd5c8ffbb81f4ac56e40323ff509d43b";

  outputs = { self, nixpkgs, github-project, ghc-wasm-meta }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: lib.genAttrs systems
        (system: f system nixpkgs.legacyPackages.${system});

      # The upstream commit the binaries are fetched from: the commit
      # imported in this repository's history (docs/provenance.md).
      upstream = {
        owner = "SeungheonOh";
        repo = "plfa-playground";
        rev = "ae0aa84c24363a8d6dadc292b6eb8f88f7f38705";
      };

      # One pin per line of upstream/assets.sha256, in sha256sum's
      # format: 64 hex digits, two spaces, a path relative to the root.
      parsePin = line:
        let m = builtins.match "([0-9a-f]{64})  (static/[^ ]+)" line;
        in if m == null
           then throw "upstream/assets.sha256: not a pin: \"${line}\""
           else { sha256 = builtins.elemAt m 0; path = builtins.elemAt m 1; };
      pins = map parsePin
        (builtins.filter (line: line != "")
          (lib.splitString "\n" (builtins.readFile ./upstream/assets.sha256)));

      fetchPin = pkgs: pin: pkgs.fetchurl {
        name = "plfa-playground-" + lib.replaceStrings [ "/" ] [ "-" ] pin.path;
        url = "https://raw.githubusercontent.com/${upstream.owner}/${upstream.repo}/${upstream.rev}/${pin.path}";
        inherit (pin) sha256;
      };

      # The compiler of issue 58, which compiler/build-agda-2.9.0.sh builds
      # from pinned sources: Agda 2.9.0 for wasm32-wasi, and the language
      # server against it as a command module and as a reactor module with
      # its JavaScript glue.  One pin per line of compiler/agda-2.9.0.sha256
      # (sha256sum's format, with a file name), fetched by hash from the
      # release that holds the files.  Where that release lives is not
      # decided yet (issue 58), so the URL below names a place that does
      # not exist: until it does, `nix build .#compiler` succeeds only
      # where the files are in the store already, added by hand from a
      # build of the recipe with `nix-store --add-fixed sha256 <file>`.
      compilerRelease = "https://github.com/formalverification/agda-wasm-builds/releases/download/agda-2.9.0-da66a8c-als-8";
      compilerPins = map (line:
          let m = builtins.match "([0-9a-f]{64})  ([^ /]+)" line;
          in if m == null
             then throw "compiler/agda-2.9.0.sha256: not a pin: \"${line}\""
             else { sha256 = builtins.elemAt m 0; name = builtins.elemAt m 1; })
        (builtins.filter (line: line != "")
          (lib.splitString "\n" (builtins.readFile ./compiler/agda-2.9.0.sha256)));
      mkCompiler = pkgs: pkgs.runCommand "agda-2.9.0-compiler" { } (''
          mkdir -p "$out"
        '' + lib.concatMapStrings (pin: ''
          install -m 444 ${pkgs.fetchurl {
            url = "${compilerRelease}/${pin.name}";
            inherit (pin) sha256;
          }} "$out/${pin.name}"
        '') compilerPins);

      # Agda's builtin library as the page ships it, agda-data.zip (issue
      # 49): the whole of an Agda's own lib/prim (its sources,
      # agda-builtins.agda-lib, and the interfaces that Agda builds for them
      # under _build/<its version>/agda/), at the root the page's server
      # reads lib/prim from, as a zip whose bytes depend on its input
      # alone: entries sorted, stored, with one fixed time.  Agda accepts
      # an interface only from the Agda version that wrote it, built from
      # the same source under the same options, and the server writes its
      # own copy of the sources before it starts (`--setup`), so `agda`
      # must be the Agda the server embeds, and nothing here names a
      # library or an option.
      #
      #   agda  that Agda, as a package with bin/agda that runs in the
      #         sandbox
      #   root  where lib/prim lies under the server's Agda_datadir, which
      #         src/lib/worker/als.ts sets to "/": "lib/prim", or
      #         "<version>/lib/prim" for a server built with Agda's
      #         use-xdg-data-home flag.  It is the shipped server's, never
      #         the input Agda's own layout.
      mkAgdaData = pkgs: { agda, root }:
        pkgs.runCommand "agda-data" { nativeBuildInputs = [ pkgs.zip ]; } ''
          agda=${lib.getExe' agda "agda"}
          # A throwaway home and data directory, both existing: an Agda
          # built with use-xdg-data-home ignores an Agda_datadir that does
          # not exist, and falls back to $XDG_DATA_HOME/agda.
          export HOME=$TMPDIR/home XDG_DATA_HOME=$TMPDIR/share \
            Agda_datadir=$TMPDIR/data
          mkdir -p "$HOME" "$XDG_DATA_HOME" "$Agda_datadir"
          "$agda" --setup > /dev/null
          prim=$("$agda" --print-agda-data-dir)/lib/prim
          version=$("$agda" --numeric-version)
          (cd "$prim" && "$agda" --build-library) > build-library.log \
            || { cat build-library.log >&2; exit 1; }
          if [ ! -d "$prim/_build/$version/agda" ]; then
            echo "Agda $version built no _build/$version/agda in $prim:" >&2
            find "$prim" -name '*.agdai' >&2
            exit 1
          fi
          echo "agda-data: Agda $version, $(grep -c 'Checking ' build-library.log) modules checked," \
            "$(find "$prim" -name '*.agdai' | wc -l) interfaces"
          mkdir -p "stage/${root}" "$out"
          cp -R "$prim/." "stage/${root}/"
          cd stage
          find . -type f -exec chmod 644 {} + -exec touch -d @315532800 {} +
          find . -type f | sed 's|^\./||' | LC_ALL=C sort \
            | TZ=UTC zip -X -D -0 -q "$out/agda-data.zip" -@
        '';

      # The standard library the page ships under Agda 2.9.0 (issue 58):
      # agda-stdlib v2.3, which agda-algebras depends on, with the three
      # patches in stdlib/patches/ (two commits of its agda-master branch,
      # and a third ported by hand), without which no released version
      # checks under 2.9.0 (issue 61, row 2b).  The archive holds what the
      # page's drive takes from it (src/, standard-library.agda-lib) and the
      # library's LICENCE, under agda-stdlib-2.3/, as a zip whose bytes
      # depend on its input alone: entries sorted, one fixed time.
      stdlibSource = pkgs: pkgs.fetchFromGitHub {
        owner = "agda";
        repo = "agda-stdlib";
        rev = "8326c7475af1fa456ca04a0203c168d5d7ff842b"; # v2.3
        hash = "sha256-JOeoek6OfyIk9vwTj5QUJU6LnRzwfiG0e0ysW6zbhZ8=";
      };
      mkStdlib = pkgs: pkgs.runCommand "agda-stdlib-2.3-patched" {
          nativeBuildInputs = [ pkgs.zip pkgs.patch ];
        } ''
          cp -R --no-preserve=mode ${stdlibSource pkgs} agda-stdlib-2.3
          for p in ${./stdlib/patches}/*.patch; do
            patch --quiet -p1 -d agda-stdlib-2.3 < "$p"
          done
          find agda-stdlib-2.3 -name '*.orig' -delete
          mkdir -p "$out"
          find agda-stdlib-2.3/src agda-stdlib-2.3/standard-library.agda-lib \
              agda-stdlib-2.3/LICENCE -type f \
            -exec chmod 644 {} + -exec touch -d @315532800 {} +
          find agda-stdlib-2.3/src agda-stdlib-2.3/standard-library.agda-lib \
              agda-stdlib-2.3/LICENCE -type f | LC_ALL=C sort \
            | TZ=UTC zip -X -D -9 -q "$out/agda-stdlib-2.3-patched.zip" -@
        '';

      # The plain agda of the 2.9.0 compiler, run under wasmtime with the
      # host's root as the guest's (so paths are the same on both sides), as
      # a package with bin/agda that runs in the sandbox.  The builtins'
      # interfaces must come from a wasm32 Agda: Agda 2.9.0 writes an
      # interface at its machine's word size, so the wasm32 server cannot
      # read what a native 64-bit Agda writes, and checks every such module
      # again, or hangs (issue 58).
      agdaWasm = pkgs: compiler: pkgs.writeShellScriptBin "agda" ''
        exec ${pkgs.wasmtime}/bin/wasmtime run --dir /::/ \
          --env HOME="$HOME" --env PWD="$(pwd)" --env Agda_datadir="$Agda_datadir" \
          ${compiler}/agda.wasm "$@"
      '';

      # The input of agda-data.zip: the Agda the page's server embeds, as
      # the compiler's plain agda (the same commit and flags, and the same
      # word size), and the root lib/prim, since the server is built
      # without use-xdg-data-home (issue 58).
      agdaDataInput = pkgs: compiler: {
        agda = agdaWasm pkgs compiler;
        root = "lib/prim";
      };

      # The 2.8.0 compiler the page ran until issue 58, upstream's
      # als-2.8ext.wasm: no longer shipped, and kept pinned, with its recipe
      # (compiler/build-agda-wasm.sh), until the 2.9.0 compiler passes
      # issue 13's gate.
      compiler-2_8_0 = {
        path = "static/als-2.8ext.wasm";
        sha256 = "53c62b0ad569a9d123f744b192c13780c494ade0cddef4daaa00db41ecd7f7a1";
      };

      # The source revision the site is named by (SvelteKit's
      # kit.version.name, and the commit vite.config.js records): the
      # commit, with "-dirty" when the tree differs from it, as `make
      # build` computes it outside the sandbox, which has no .git.
      revision = self.rev or self.dirtyRev or "unknown";

      # What the site's build reads, and nothing else, so that a change
      # to the documentation or the plan does not change its source.
      siteSource = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./Makefile
          ./NOTICE
          ./licenses
          ./upstream/assets.sha256
          ./package.json
          ./package-lock.json
          ./svelte.config.js
          ./vite.config.js
          ./tsconfig.json
          ./tsconfigs
          ./scripts/asset-manifest.mjs
          ./scripts/prepare-cloudflare-assets.mjs
          ./src
          ./static
        ];
      };

      # The npm dependencies: every package package-lock.json names, for
      # every platform, fetched once by hash.  After a change to the
      # lockfile, set npmDepsHash to lib.fakeHash, build, and copy the
      # hash the failure reports.
      npmDepsHash = "sha256-4AJmGkkw8pveLasWMlQ4KUptfA2BKH4N7wsdAWn1NGQ=";
      npmDeps = pkgs: pkgs.fetchNpmDeps {
        name = "agda-native-ide-npm-deps";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [ ./package.json ./package-lock.json ];
        };
        hash = npmDepsHash;
      };
    in
    {
      packages = forAllSystems (system: pkgs: let
        compiler = mkCompiler pkgs;
        stdlib = mkStdlib pkgs;
        agdaData = mkAgdaData pkgs (agdaDataInput pkgs compiler);
      in rec {
        # Agda's builtin library, built (mkAgdaData).
        agda-data = agdaData;

        # The 2.9.0 compiler, fetched by its pins (mkCompiler).
        inherit compiler;

        # The 2.8.0 compiler, kept pinned and not shipped.
        compiler-2_8_0 = fetchPin pkgs compiler-2_8_0;

        # The standard library the page ships, patched (mkStdlib).
        inherit stdlib;

        # Every binary the app ships at its path in the tree (static/...):
        # upstream's pinned ones, agda-data.zip, the compiler's language
        # server (as als-2.9.0.wasm) and the standard library.
        assets = pkgs.runCommand "plfa-playground-assets" { } (
          lib.concatMapStrings (pin: ''
            install -D -m 444 ${fetchPin pkgs pin} "$out/${pin.path}"
          '') pins + ''
            install -D -m 444 ${agdaData}/agda-data.zip "$out/static/agda-data.zip"
            install -D -m 444 ${compiler}/als.wasm "$out/static/als-2.9.0.wasm"
            install -D -m 444 ${stdlib}/agda-stdlib-2.3-patched.zip "$out/static/agda-stdlib-2.3-patched.zip"
          '');

        # The static site, as `make build` writes it into build/.
        site = pkgs.buildNpmPackage {
          name = "agda-native-ide-site";
          src = siteSource;
          nodejs = pkgs.nodejs_22;
          npmDeps = npmDeps pkgs;
          preBuild = ''
            cp -R --no-preserve=mode ${assets}/static/. static/
          '';
          buildPhase = ''
            runHook preBuild
            make build SITE_REVISION=${revision}
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            cp -R build "$out"
            runHook postInstall
          '';
          # The output is what `make build` wrote, byte for byte: nothing
          # in it runs here, so fixup (which would rewrite a `#!` line)
          # has nothing to do.
          dontFixup = true;
        };
      });

      # mkAgdaData, for a build of agda-data.zip from another Agda (issue
      # 58): `(builtins.getFlake ...).lib.mkAgdaData pkgs { agda; root; }`.
      lib = { inherit mkAgdaData; };

      devShells = forAllSystems (system: pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.gnumake
            pkgs.gh
            pkgs.nodejs_22
            github-project.packages.${system}.gh-project-engine
          ];
        };
      } // lib.optionalAttrs (ghc-wasm-meta.packages ? ${system}) {
        # `nix develop .#compiler --command compiler/build-agda-2.9.0.sh`:
        # the toolchain that builds the compiler (issue 58), and the native
        # tools the build runs (alex and happy generate Agda's lexer and
        # parser, hpack the server's cabal file, autoreconf its network
        # submodule's configure, node GHC's post-linker).
        compiler = pkgs.mkShell {
          packages = (with ghc-wasm-meta.packages.${system}; [
            wasm32-wasi-ghc-9_10
            wasm32-wasi-cabal-9_10
            binaryen
            wasmtime
          ]) ++ [
            pkgs.git
            pkgs.alex
            pkgs.happy
            pkgs.hpack
            pkgs.autoconf
            pkgs.automake
            pkgs.nodejs_22
          ];
        };
      });

      # `nix run .#update -- docs/GITHUB_PROJECT.md`, pinned by this
      # project's own flake.lock.
      #
      # `nix run .#browser-check -- <site> [--out DIR]` checks Main.agda
      # in a built site (build/, or `nix build .#site`'s result) in
      # headless Chromium, with node and Chromium both pinned here
      # (scripts/browser-check/run.mjs).  Linux only: nixpkgs builds
      # Chromium for Linux alone.
      apps = forAllSystems (system: pkgs:
        github-project.apps.${system}
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          browser-check = {
            type = "app";
            program = toString (pkgs.writeShellScript "browser-check" ''
              export CHROME=${lib.getExe pkgs.chromium}
              exec ${lib.getExe pkgs.nodejs_22} ${./scripts/browser-check}/run.mjs "$@"
            '');
            meta.description = "Check Main.agda in a built site, in headless Chromium";
          };
        });
    };
}
