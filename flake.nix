{
  description = "AIOStreams - Stremio super-addon aggregator";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      src = nixpkgs.lib.cleanSourceWith {
        src = ./.;
        filter = path: type:
          let
            relPath = nixpkgs.lib.removePrefix (toString ./. + "/") (toString path);
          in
          # These get excluded anywhere in the tree (build/dep artifacts).
          !(type == "directory"
            && builtins.elem (baseNameOf path)
            [
              "node_modules"
              "dist"
              "coverage"
              ".pnpm-store"
              ".git"
            ])
          # These only mean "local runtime state" at the repo root — matching
          # by bare name anywhere also strips real source dirs that happen to
          # share the name, e.g. packages/frontend/src/app/dashboard/cache.
          && !(type == "directory" && builtins.elem relPath [ "data" "cache" "uploads" ]);
      };
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          aiostreams = pkgs.callPackage ./nix/package.nix { inherit src; };
        in
        {
          inherit aiostreams;
          default = aiostreams;
        });

      nixosModules = {
        aiostreams = import ./nix/module.nix { inherit self; };
        default = self.nixosModules.aiostreams;
      };
    };
}