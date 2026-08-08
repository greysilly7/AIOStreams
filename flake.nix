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
          !(type == "directory"
            && builtins.elem (baseNameOf path)
            [
              "node_modules"
              "dist"
              "coverage"
              ".pnpm-store"
              "data"
              "cache"
              ".git"
              "uploads"
            ]);
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