# File: flake.nix
#
# The project's dev shell, the github-project roadmap engine, and the
# binaries the app ships, pinned by hash.
#
# `nix develop` puts the gh-project-* CLIs on PATH (the Makefile stub
# finds them there), and the re-exported apps allow `nix run .#update`
# directly.  Upgrade the engine deliberately with
# `nix flake update github-project`.
#
# `nix build .#assets` fetches every binary named in
# upstream/assets.sha256 from upstream's repository at the commit this
# repository imported, one fixed-output fetch per file, so a byte that
# differs from its pin fails the fetch.  `make assets` copies the result
# into static/, and `make build` checks static/ against the same pins
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

  outputs = { self, nixpkgs, github-project }:
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
      packages = forAllSystems (system: pkgs: rec {
        # Every pinned binary at its path in the tree (static/...).
        assets = pkgs.runCommand "plfa-playground-assets" { } (
          lib.concatMapStrings (pin: ''
            install -D -m 444 ${fetchPin pkgs pin} "$out/${pin.path}"
          '') pins);

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

      devShells = forAllSystems (system: pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.gnumake
            pkgs.gh
            pkgs.nodejs_22
            github-project.packages.${system}.gh-project-engine
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
