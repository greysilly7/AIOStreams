# NixOS module for AIOStreams.
#
# Enable with:
#
#   { config, lib, pkgs, ... }: {
#     imports = [ (import /path/to/aiostreams/nix/module.nix { }) ];
#     services.aiostreams.enable = true;
#     services.aiostreams.port = 3000;
#     # services.aiostreams.secretKeyFile = "/run/secrets/aiostreams-key"; # 64 hex chars
#   }
#
# If `package` is unset the module falls back to `self.packages.${pkgs.system}.aiostreams`
# (flake usage) and finally to `pkgs.aiostreams`.
#
# Runs a single systemd unit (`aiostreams.service`) hosting the API/SPA.
# Persistent state lives in /var/lib/aiostreams (SQLite DB + disk cache).
{ self ? null }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.aiostreams;

  pkg =
    if cfg.package != null then
      cfg.package
    else if self != null && self.packages or { } ? ${pkgs.system}.aiostreams then
      self.packages.${pkgs.system}.aiostreams
    else
      pkgs.aiostreams or (throw "aiostreams: no package found. Set services.aiostreams.package or import the flake.");

  # UnityEngine-free env assembly: drop nulls, merge extra.
  env = lib.filterAttrs (_: v: v != null) {
    NODE_ENV = "production";
    PORT = toString cfg.port;
    LOG_LEVEL = cfg.level;
    BASE_URL = cfg.baseUrl;
    INTERNAL_URL = cfg.internalUrl;
    DATABASE_URI = cfg.databaseUri;
    DISK_CACHE_DIR = cfg.diskCacheDir;
    REDIS_URI = cfg.redisUrl;
    SECRET_KEY = cfg.secretKey;
    AIOSTREAMS_AUTH =
      if cfg.authUser != null then "${cfg.authUser.username}:${cfg.authUser.password}" else null;
  }
  // cfg.extraEnv;
in
{
  options.services.aiostreams = {
    enable = lib.mkEnableOption "the AIOStreams Stremio super-addon server";

    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      description = "The aiostreams package (e.g. from the flake packages output).";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "TCP port the HTTP server listens on.";
    };

    level = lib.mkOption {
      type = lib.types.enum [ "fatal" "error" "warn" "info" "debug" "trace" ];
      default = "info";
      description = "Pino log level.";
    };

    baseUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "https://addon.example.com";
      description = "Public base URL of this addon instance.";
    };

    internalUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Internal URL built-in addons use to reach this server.";
    };

    databaseUri = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Database URI (sqlite:// or postgres://). Defaults to a SQLite file in the state directory.";
    };

    diskCacheDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Directory for disk-backed caches. Defaults to a cache dir under the data dir.";
    };

    redisUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional Redis URI (REDIS_URI).";
    };

    secretKey = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Session/encryption secret: a 64-char hex string (openssl rand -hex 32).
        Configs stored in the DB are encrypted with it; changing it after first
        run invalidates stored configs. Prefer secretKeyFile for provisioning.
      '';
    };

    authUser = lib.mkOption {
      type = lib.types.nullOr (lib.types.submodule {
        options = {
          username = lib.mkOption {
            type = lib.types.str;
            description = "Username for the AIOSTREAMS_AUTH bootstrap account.";
          };
          password = lib.mkOption {
            type = lib.types.str;
            description = "Plaintext password (wire via agenix/sops secret for real use).";
          };
        };
      });
      default = null;
      description = "Bootstrap admin credentials passed as AIOSTREAMS_AUTH.";
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/aiostreams";
      description = "Directory for the SQLite DB and disk cache (state dir).";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open cfg.port in the firewall.";
    };

    extraEnv = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Arbitrary additional environment variables for the server process.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.aiostreams = {
      description = "AIOStreams service user";
      isSystemUser = true;
      group = "aiostreams";
      home = cfg.dataDir;
      createHome = true;
    };
    users.groups.aiostreams = { };

    systemd.services.aiostreams = {
      description = "AIOStreams Stremio super-addon server";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];

      serviceConfig = {
        Type = "simple";
        User = "aiostreams";
        Group = "aiostreams";
        ExecStart = "${pkg}/bin/aiostreams-server";
        WorkingDirectory = cfg.dataDir;
        StateDirectory = "aiostreams";

        Restart = "on-failure";
        RestartSec = "5s";

        # sandboxing
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        RestrictRealtime = true;
        RestrictNamespaces = true;
        # V8's JIT needs W^X-toggling mprotect() calls; MemoryDenyWriteExecute
        # blocks exactly that via seccomp, crashing Node with SIGTRAP on
        # startup before it can even bind the listener.
        MemoryDenyWriteExecute = false;
        LockPersonality = true;
        CapabilityBoundingSet = "";
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
      };

      environment = env;
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}