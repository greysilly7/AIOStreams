# Build package for the AIOStreams Node workspace (core + server + frontend).
# Produces:
#   $out/bin/aiostreams-server   - node wrapper that starts the API server
#   $out/lib/aiostreams/         - full working tree (dist outputs, node_modules)
{ pkgs, src }:

let
  inherit (pkgs) lib;
  nodejs = pkgs.nodejs_24 or pkgs.nodejs;
  pnpmTool = pkgs.pnpm or pkgs.corepack; # packageManager: pnpm@11 (via corepack if pnpm not packaged)

  pnpmDeps = pkgs.fetchPnpmDeps {
    inherit src;
    name = "aiostreams-pnpm-deps";
  };

  builder = with pkgs; stdenv.mkDerivation;
in
pkgs.stdenv.mkDerivation {
  pname = "aiostreams";
  version = "2.32.1";
  inherit src;

  nativeBuildInputs = [
    nodejs
    pnpmTool
    pkgs.python3 # node-gyp (better-sqlite3) compile
    pkgs.gcc13 # C toolchain for native modules
  ];

  NODE_OPTIONS = "--max-old-space-size=8192";

  buildPhase = ''
    runHook preBuild

    export HOME="$PWD"
    export npm_config_store_dir="$pnpmDeps"
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    # pnpm's own "manage-package-manager-versions" tries to fetch/verify the
    # exact packageManager-pinned pnpm release from the registry, which the
    # offline build sandbox can't reach — nixpkgs' pnpm is close enough.
    export npm_config_manage_package_manager_versions=false

    # offline install against the prefetched pnpm store; native scripts run so
    # better-sqlite3 compiles its bundled sqlite3.c in the build sandbox
    pnpm install --offline --frozen-lockfile --ignore-scripts=false
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