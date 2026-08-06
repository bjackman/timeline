{
  description = "A zoomable timeline of every event and time period with a Wikipedia page";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        inherit (pkgs) lib;

        node = pkgs.nodejs_22;

        # Only the files the build actually reads, so editing a doc does not
        # invalidate the derivation.
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./web
            ./data
            ./tools
          ];
        };

        # The single self-contained HTML file. Pure: it reads the checked-in
        # slice and the two modules and concatenates them, no network.
        standalone = pkgs.stdenv.mkDerivation {
          pname = "timeline-standalone";
          version = "0.1.0";
          inherit src;
          nativeBuildInputs = [ node ];
          buildPhase = ''
            runHook preBuild
            node tools/build-standalone.mjs --out timeline.html
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp timeline.html $out/
            runHook postInstall
          '';
        };

        # A directory ready to serve or drop on a CDN. Deliberately the bundled
        # single file rather than the web/ + data/ dev layout: the dev page
        # fetches ../data/slice.json, which only resolves when the server root
        # is the repo root. Shipping the bundle sidesteps that entirely and is
        # what DESIGN.md calls for anyway — static, no backend, no fetch.
        site = pkgs.runCommand "timeline-site" { } ''
          mkdir -p $out
          cp ${standalone}/timeline.html $out/index.html
        '';

        # `nix flake check` warns about apps without meta, so build them through
        # one helper that always sets it.
        mkApp =
          {
            name,
            description,
            runtimeInputs ? [ ],
            text,
          }:
          {
            type = "app";
            program = lib.getExe (pkgs.writeShellApplication { inherit name runtimeInputs text; });
            meta.description = description;
          };
      in
      {
        packages = {
          default = site;
          inherit site standalone;
        };

        checks = {
          # The time-scale maths: pure, no network, fast. This is the part most
          # likely to be subtly wrong in ways that still look plausible on
          # screen, so it is the thing worth gating on.
          scale-tests = pkgs.runCommand "timeline-scale-tests" { nativeBuildInputs = [ node ]; } ''
            cd ${src}
            node tools/test-scale.mjs | tee $out
          '';

          # Category classification. Also pure and offline — it reads the
          # committed slice and the committed closures — and it guards an
          # ordering that is easy to break by accident, since fixing one
          # classification by reordering the rules is how another regresses.
          category-tests =
            pkgs.runCommand "timeline-category-tests" { nativeBuildInputs = [ node ]; }
              ''
                cd ${src}
                node tools/test-categories.mjs | tee $out
              '';

          # Guards the bundler's own invariants — it refuses to emit output if
          # module syntax survives flattening or the script tag is not replaced.
          inherit standalone;
        };

        apps = rec {
          default = serve;

          # Serve the built bundle: one file, at the root. Works from anywhere
          # since it serves the store path, not the cwd.
          serve = mkApp {
            name = "timeline-serve";
            description = "Serve the built timeline on localhost";
            runtimeInputs = [ pkgs.python3 ];
            text = ''
              port="''${1:-8000}"
              echo "timeline: http://localhost:$port/"
              cd ${site}
              exec python3 -m http.server "$port"
            '';
          };

          # Serve the working tree for iteration. Must run from the repo root:
          # the dev page fetches ../data/slice.json, so the server root has to
          # be the repo and the entry point is /web/.
          dev = mkApp {
            name = "timeline-dev";
            description = "Serve the working tree for development (run from the repo root)";
            runtimeInputs = [ pkgs.python3 ];
            text = ''
              if [ ! -f web/index.html ] || [ ! -f data/slice.json ]; then
                echo "error: run this from the repository root (need web/ and data/)" >&2
                exit 1
              fi
              port="''${1:-8000}"
              echo "timeline (working tree): http://localhost:$port/web/"
              exec python3 -m http.server "$port"
            '';
          };

          # Refreshes data/slice.json from the Wikidata Query Service. An app
          # rather than a package because it needs network, which a Nix build
          # sandbox does not have. Takes ~20 minutes and is deliberately rate
          # limited; WDQS is volunteer-run.
          fetch-slice = mkApp {
            name = "timeline-fetch-slice";
            description = "Re-fetch data/slice.json from Wikidata (~20 min, needs network)";
            runtimeInputs = [ node ];
            text = ''
              if [ ! -f tools/fetch-slice.mjs ]; then
                echo "error: run this from the repository root" >&2
                exit 1
              fi
              exec node tools/fetch-slice.mjs "$@"
            '';
          };

          # Fills in data/type-closures.json for any P31 type the category
          # rules have not seen. fetch-slice does this itself for what it
          # harvests, so this is for tuning against types outside the current
          # slice. Needs network, hence an app.
          fetch-closures = mkApp {
            name = "timeline-fetch-closures";
            description = "Fetch missing P279* type closures from Wikidata (needs network)";
            runtimeInputs = [ node ];
            text = ''
              if [ ! -f tools/fetch-closures.mjs ]; then
                echo "error: run this from the repository root" >&2
                exit 1
              fi
              exec node tools/fetch-closures.mjs "$@"
            '';
          };

          # Re-classify the slice from the cached closures. Offline and
          # instant, which is the entire point of caching the closures: a
          # tuning round costs nothing and hits WDQS zero times.
          recategorise = mkApp {
            name = "timeline-recategorise";
            description = "Re-classify data/slice.json from cached closures (offline)";
            runtimeInputs = [ node ];
            text = ''
              if [ ! -f tools/recategorise.mjs ]; then
                echo "error: run this from the repository root" >&2
                exit 1
              fi
              exec node tools/recategorise.mjs "$@"
            '';
          };

          # Also exposed as checks.scale-tests and checks.category-tests; this
          # is the form you want while iterating, since it prints straight to
          # the terminal. Runs from ${src} because the category tests read the
          # committed data files by relative path.
          test = mkApp {
            name = "timeline-test";
            description = "Run the time-scale and category tests";
            runtimeInputs = [ node ];
            text = ''
              cd ${src}
              node tools/test-scale.mjs
              node tools/test-categories.mjs
            '';
          };
        };

        devShells.default = pkgs.mkShell {
          packages = [
            node
            pkgs.python3
            pkgs.jq # the WDQS notes lean on it for poking at slice.json
          ];

          # tools/screenshot.mjs honours CHROMIUM_PATH, which avoids Playwright
          # trying to download a browser build. Playwright itself stays out of
          # the shell on purpose: install it ad hoc with
          # `npm install --no-save playwright` when you need screenshots.
          CHROMIUM_PATH = "${pkgs.chromium}/bin/chromium";
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

          shellHook = ''
            echo "timeline dev shell — node $(node --version)"
            echo "  node tools/test-scale.mjs        run the scale tests"
            echo "  node tools/test-categories.mjs   run the category tests"
            echo "  node tools/recategorise.mjs --dry-run   preview classification"
            echo "  python3 -m http.server 8000      then open /web/"
            echo "  node tools/build-standalone.mjs  -> dist/timeline.html"
          '';
        };

        formatter = pkgs.nixfmt-rfc-style;
      }
    );
}
