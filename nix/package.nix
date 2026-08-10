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
    pkgs.python3 # node-gyp (better-sqlite3, yencode) compile
    pkgs.gcc13 # C toolchain for native modules
    # yencode bundles crcutil as a C dependency, bootstrapped via
    # autotools (configure/Makefile.am/autogen.sh) before node-gyp
    # links against it.
    pkgs.autoconf
    pkgs.automake
    pkgs.libtool
    pkgs.pkg-config
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

    # Re-run the install without --ignore-scripts to build the plain
    # onlyBuiltDependencies packages (bcrypt/better-sqlite3/sharp/sqlite3/
    # core-js/esbuild/unrs-resolver). --force is required: a plain
    # re-install treats the lockfile as already satisfied and skips
    # everything, since pnpmConfigHook already materialized node_modules
    # (just without scripts).
    pnpm install --offline --frozen-lockfile --force

    # yencode is the one onlyBuiltDependencies entry that's also a
    # patched dependency (patchedDependencies), and its build/ directory
    # never gets created via pnpm's own install/rebuild machinery no
    # matter how it's invoked or scoped — node-gyp simply never starts
    # for it. Rather than fight pnpm's allowlist-matching for a patched
    # package further, build it directly: find wherever pnpm placed it
    # in the content-addressed store and run its own install script
    # (node-gyp rebuild) by hand. `pnpm --dir ... run install` (not a
    # bare `node-gyp rebuild`) reuses pnpm's own PATH/env setup for
    # locating node-gyp — the same mechanism that already successfully
    # builds bcrypt above; a bare `node-gyp` isn't on PATH itself.
    yencode_dir=$(find node_modules/.pnpm -maxdepth 1 -iname 'yencode@*' -print -quit)
    if [ -z "$yencode_dir" ]; then
      echo "ERROR: yencode not found under node_modules/.pnpm" >&2
      exit 1
    fi
    pnpm --dir "$yencode_dir/node_modules/yencode" run install
    test -f "$yencode_dir/node_modules/yencode/build/Release/yencode.node"

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
