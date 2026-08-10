# Build package for the AIOStreams Node workspace (core + server + frontend).
# Produces:
#   $out/bin/aiostreams-server   - node wrapper that starts the API server
#   $out/lib/aiostreams/         - full working tree (dist outputs, node_modules)
{ pkgs, src }:

let
  inherit (pkgs) lib;
  nodejs = pkgs.nodejs_24 or pkgs.nodejs;
  pnpm = pkgs.pnpm_11 or pkgs.pnpm; # packageManager: pnpm@11

  # fetcherVersion 4 dumps the pnpm store as a SQLite SQL file; pnpmConfigHook
  # (nativeBuildInputs, below) rehydrates it during configurePhase. Without
  # the hook, pnpm can't see any of these packages as "reused" and silently
  # falls back to the network for the entire dependency graph.
  pnpmDeps = pkgs.fetchPnpmDeps {
    inherit src pnpm;
    pname = "aiostreams";
    version = "2.32.1";
    fetcherVersion = 4;
    hash = "sha256-+poFpcuKYsuIfFHx9Qq6FJAeeoWrUt4HCfA+fTLApBM=";
  };
in
pkgs.stdenv.mkDerivation {
  pname = "aiostreams";
  version = "2.32.1";
  inherit src pnpmDeps;

  nativeBuildInputs = [
    nodejs
    pnpm
    pkgs.pnpmConfigHook
    pkgs.python3 # node-gyp (better-sqlite3) compile
    pkgs.gcc13 # C toolchain for native modules
  ];

  NODE_OPTIONS = "--max-old-space-size=8192";

  buildPhase = ''
    runHook preBuild

    export HOME="$PWD"
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

    # pnpm self-reconciles against package.json's packageManager pin by
    # querying the npm registry for that exact release, which the offline
    # build sandbox can't reach. Drop the pin — nixpkgs' pnpm (already on
    # PATH via nativeBuildInputs) is close enough, and this only touches
    # the ephemeral build copy.
    sed -i '/"packageManager":/d' package.json

    # pnpmConfigHook already materialized node_modules from pnpmDeps'
    # rehydrated store during configurePhase — but it hardcodes
    # --ignore-scripts on that install by design (a config hook shouldn't
    # run arbitrary scripts automatically). This re-check is just a fast
    # no-op against the already-satisfied lockfile.
    pnpm install --offline --frozen-lockfile

    # Explicitly trigger the native builds pnpmConfigHook deliberately
    # skipped, for exactly the onlyBuiltDependencies-allowlisted packages
    # (bcrypt, better-sqlite3, sharp, sqlite3, yencode, etc. — see
    # pnpm-workspace.yaml). Without this, e.g. yencode's
    # build/Release/yencode.node never gets compiled, with no error.
    pnpm rebuild
    pnpm run metadata
    pnpm build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/bin" "$out/lib/aiostreams"
    cp -a --no-preserve=mode . "$out/lib/aiostreams/"

    cat >"$out/bin/aiostreams-server" <<'EOF_SERVER'
    #!/nix/store/__NODE__/bin/node
    "use strict";
    require(__dirname + "/../lib/aiostreams/packages/server/dist/server.js");
    EOF_SERVER
    sed -i "s|/nix/store/__NODE__|${nodejs}|" "$out/bin/aiostreams-server"
    chmod +x "$out/bin/aiostreams-server"

    runHook postInstall
  '';

  meta = {
    description = "Stremio super-addon aggregating Stremio addons and debrid services";
    homepage = "https://aiostreams.github.io";
    license = lib.licenses.mit;
    mainProgram = "aiostreams-server";
  };
}
