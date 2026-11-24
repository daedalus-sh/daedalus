# platform/container-revive — a container that dies is started again, a
# bounded number of times.
#
# Every container unit is `Type=oneshot` + `RemainAfterExit` around
# `podman run -d --rm` (podman.nix says why), so a container that exits
# mid-life leaves a green unit and nothing running: systemd saw the start
# succeed and has no process to watch. Until this module the only thing that
# noticed was an alert, and a person did the restart.
#
# container-revive.sh runs every minute and restarts the UNIT of a declared
# container that is absent while its unit is `active`, seen so on two sweeps
# in a row. The cap is the point of it:
#   - at most 3 restarts per container; the count is forgotten once the
#     container has stayed up 30 minutes after its last one;
#   - after the third it logs once and leaves the container down, which is
#     the state the "Container Disappeared" alert mails about;
#   - a unit that is inactive (stopped on purpose), failed or activating is
#     never touched, so `systemctl stop podman-<name>` is how to keep a
#     container down. A bare `podman stop` is a death like any other.
#   - nothing is judged while the box boots or shuts down, while a rebuild
#     holds `fleet.rebuildLock` or a switch runs, or when podman itself does
#     not answer.
# Restarting the unit, not the container: the unit's own start is the only
# place the run options, the pre-start cleanup and the ordering live, and a
# restart of a network-namespace owner carries its tenants through
# `Requires=`, as a hand restart does.
#
# State is /run/container-revive (gone at reboot, which also forgives every
# count). `total/<name>` there is how many times each container was revived
# since boot; modules/monitoring exports it as container_revives_total, and
# its rules mail when a container that keeps being revived keeps dying.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.fleet.containerRevive;
  inherit (config.fleet) operator;
  stateDir = "/run/container-revive";

  names = lib.subtractLists cfg.exclude (
    lib.attrNames config.virtualisation.oci-containers.containers
  );

  revive = pkgs.writeShellApplication {
    name = "container-revive";
    runtimeInputs = [
      config.systemd.package
      pkgs.podman
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.util-linux
    ];
    text = ''
      CONTAINERS=${lib.escapeShellArg (lib.concatStringsSep " " names)}
      STATE_DIR=${stateDir}
      LOCK=${config.fleet.rebuildLock}
      USER_NAME=${operator.user}
      USER_GROUP=${operator.group}
      USER_HOME=${operator.home}
      USER_RUNTIME=${operator.runtimeDir}
      PATH="$PATH:/run/wrappers/bin"

      ${builtins.readFile ./container-revive.sh}
    '';
  };
in
{
  options.fleet.containerRevive = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Restart a declared container that exited while its unit stayed
        active, at most three times before leaving it down
        (platform/container-revive).
      '';
    };
    exclude = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "scratch-service" ];
      description = ''
        Containers the sweep never restarts: one being worked on, whose
        deaths are expected and whose restarts would only get in the way.
      '';
    };
    stateDir = lib.mkOption {
      type = lib.types.str;
      default = stateDir;
      readOnly = true;
      description = "Where the sweep keeps its counts; `total/<container>` is revives since boot.";
    };
  };

  config = lib.mkIf (cfg.enable && names != [ ]) {
    systemd.services.container-revive = {
      description = "Restart containers that died behind an active unit";
      after = [
        "podman-rootless-ready.service"
        "linger-users.service"
      ];
      serviceConfig = {
        Type = "oneshot";
        RuntimeDirectory = "container-revive";
        RuntimeDirectoryPreserve = true;
        ExecStart = lib.getExe revive;
      };
    };
    systemd.timers.container-revive = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "5min";
        OnUnitActiveSec = "1min";
        AccuracySec = "5s";
      };
    };
    # OnFailure mail only: the script exits 0 on every path it knows, so a
    # failure is a broken sweep, which is worth hearing about.
    fleet.monitoredJobs.container-revive = { };
  };
}
