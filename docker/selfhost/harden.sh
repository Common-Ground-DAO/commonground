#!/bin/bash
# Base hardening of a dedicated Ubuntu/Debian server that runs a self-hosted
# Common Ground instance (docker/SELFHOST.md, "Server hardening"):
#
#   ssh       key-only login: password/keyboard-interactive login off; root
#             login limited to keys if it was fully open. Refused unless the
#             operator has a usable authorized key and has logged in with a
#             key before — never locks the operator out.
#   firewall  ufw: incoming denied except SSH (the ports sshd really listens
#             on), 80/tcp, 443/tcp+udp, 4443/tcp, 40000-40099/udp+tcp, for
#             IPv4 and IPv6. Refused when sshd's ports are unclear. Docker-
#             published ports bypass ufw; every other published port is listed.
#   upgrades  unattended-upgrades with the distribution's default origins
#             (security updates), daily, Docker/containerd/runc excluded. No
#             automatic reboot.
#   logs      journald capped (1 GB, 4 weeks); logrotate installed. Container
#             logs rotate through the compose files (docker-compose.selfhost.yml).
#   sysctl    net.ipv4.ip_local_reserved_ports = 40000-40099 (the mediasoup
#             ports are not handed out as ephemeral ports) and
#             vm.overcommit_memory = 1 (Valkey's background saves fork).
#
# Usage: sudo ./selfhost/harden.sh [--dry-run] [--ssh-user <name>] [--skip <part>]...
#   --dry-run          print every change (file diffs, commands), change nothing;
#                      runs without root as far as it can read the system
#   --ssh-user <name>  the account you log in with (default: the login user of
#                      this session — /proc/self/loginuid, also after `sudo su -`
#                      — else $SUDO_USER, else the current user)
#   --skip <part>      leave out ssh | firewall | upgrades | logs | sysctl
#                      (repeatable)
#   --no-login-check   do not require a past key login of the operator in the
#                      logs (e.g. when the logs were rotated away)
#
# Idempotent: a second run changes nothing and says so. Exit code 0 when
# everything is (or would be) in place, 1 when a part failed or was refused,
# 2 for a usage error.
set -uo pipefail

DRY_RUN=false
SSH_USER=""
SKIP=" "
LOGIN_CHECK=true
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --ssh-user)
      if [ -z "${2:-}" ] || [ "${2#-}" != "${2}" ]; then
        echo "--ssh-user needs an account name" >&2
        exit 2
      fi
      SSH_USER="$2"
      shift ;;
    --skip)
      case "${2:-}" in
        ssh|firewall|upgrades|logs|sysctl) SKIP="$SKIP$2 " ;;
        *) echo "--skip takes ssh, firewall, upgrades, logs or sysctl" >&2; exit 2 ;;
      esac
      shift ;;
    --no-login-check) LOGIN_CHECK=false ;;
    -h|--help) sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

# the ports the stack needs from the internet (docker-compose.selfhost*.yml)
FIREWALL_RULES=(80/tcp 443/tcp 443/udp 4443/tcp 40000:40099/udp 40000:40099/tcp)
ALLOWED_PUBLISHED="80/tcp 443/tcp 443/udp 4443/tcp"   # plus 40000-40099 tcp/udp
SSHD_DROPIN=/etc/ssh/sshd_config.d/10-commonground.conf
SYSCTL_FILE=/etc/sysctl.d/90-commonground.conf
JOURNALD_DROPIN=/etc/systemd/journald.conf.d/90-commonground.conf
AUTO_UPGRADES=/etc/apt/apt.conf.d/20auto-upgrades
UPGRADES_BLACKLIST=/etc/apt/apt.conf.d/51commonground-unattended-upgrades
UFW_DEFAULTS=/etc/default/ufw

FAILED=0
CHANGES=0
WARNINGS=0
IS_ROOT=false
[ "$(id -u)" = 0 ] && IS_ROOT=true

say()    { printf '%s\n' "$*"; }
ok()     { printf '  [ok]      %s\n' "$*"; }
change() { CHANGES=$((CHANGES + 1)); if $DRY_RUN; then printf '  [would]   %s\n' "$*"; else printf '  [change]  %s\n' "$*"; fi; }
warn()   { WARNINGS=$((WARNINGS + 1)); printf '  [warn]    %s\n' "$*"; }
fail()   { FAILED=1; printf '  [FAILED]  %s\n' "$*"; }
skipped() { case "$SKIP" in *" $1 "*) say "== $1: skipped (--skip $1)"; return 0 ;; esac; return 1; }

# runs a command, or prints it in a dry run
run() {
  if $DRY_RUN; then
    printf '            $ %s\n' "$*"
    return 0
  fi
  "$@"
}

# write_file <path> <mode> <content>: writes only when the content differs; a
# dry run prints the diff. Returns 0 when it wrote (or would write), 1 when
# the file is up to date, 2 when writing failed (reported through fail).
write_file() {
  local path="$1" mode="$2" content="$3" tmp
  if [ -f "$path" ] && [ "$(cat "$path")" = "$content" ]; then
    ok "$path is up to date"
    return 1
  fi
  change "write $path"
  if $DRY_RUN; then
    diff -u --label "$path (now)" --label "$path (new)" <(cat "$path" 2>/dev/null) <(printf '%s\n' "$content") | sed 's/^/            /'
    return 0
  fi
  if mkdir -p "$(dirname "$path")" && tmp="$(mktemp "$path.XXXXXX")" &&
     printf '%s\n' "$content" > "$tmp" && chmod "$mode" "$tmp" && mv "$tmp" "$path"; then
    return 0
  fi
  [ -n "${tmp:-}" ] && rm -f "$tmp"
  fail "could not write $path"
  return 2
}

pkg_installed() {
  [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" = "install ok installed" ]
}

ensure_packages() {
  local missing=() p
  for p in "$@"; do
    pkg_installed "$p" || missing+=("$p")
  done
  if [ ${#missing[@]} -eq 0 ]; then
    ok "installed: $*"
    return 0
  fi
  change "install ${missing[*]}"
  if $DRY_RUN; then
    run apt-get update
    run apt-get install -y "${missing[@]}"
    return 0
  fi
  # apt's progress output only when something goes wrong
  local log
  log="$(mktemp)"
  if DEBIAN_FRONTEND=noninteractive apt-get update -q > "$log" 2>&1 &&
     DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${missing[@]}" >> "$log" 2>&1; then
    rm -f "$log"
    return 0
  fi
  tail -n 20 "$log" | sed 's/^/            /'
  rm -f "$log"
  return 1
}

has_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }

# the account of this login session: the kernel's loginuid survives sudo and
# `sudo su -` (4294967295 = not set, e.g. a console without pam_loginuid)
login_user() {
  local uid
  uid="$(cat /proc/self/loginuid 2>/dev/null)"
  [ -n "$uid" ] && [ "$uid" != 4294967295 ] || return 1
  getent passwd "$uid" | cut -d: -f1
}

# ---------------------------------------------------------------- preflight
if ! $IS_ROOT && ! $DRY_RUN; then
  echo "Run as root (sudo $0), or with --dry-run to see what it would change." >&2
  exit 2
fi
if [ ! -r /etc/os-release ] || ! grep -qE '^ID(_LIKE)?=.*(debian|ubuntu)' /etc/os-release; then
  echo "This script supports Ubuntu and Debian only (/etc/os-release)." >&2
  exit 2
fi
OPERATOR_SOURCE="--ssh-user"
if [ -z "$SSH_USER" ]; then
  if SSH_USER="$(login_user)" && [ -n "$SSH_USER" ]; then
    OPERATOR_SOURCE="login session"
  elif [ -n "${SUDO_USER:-}" ]; then
    SSH_USER="$SUDO_USER"
    OPERATOR_SOURCE="sudo"
  else
    SSH_USER="$(id -un)"
    OPERATOR_SOURCE="current user"
  fi
fi
# shellcheck source=/dev/null
. /etc/os-release
say "Server hardening on ${PRETTY_NAME:-unknown} — operator account: $SSH_USER (from: $OPERATOR_SOURCE)$($DRY_RUN && echo ' — dry run: nothing is changed')"
$DRY_RUN && ! $IS_ROOT && say "Not root: parts that need root to read the system are reported as unknown."

# ------------------------------------------------------------------- sysctl
part_sysctl() {
  skipped sysctl && return 0
  say "== sysctl"
  local content
  content="# Common Ground self-host (docker/selfhost/harden.sh)
# mediasoup's WebRTC ports must never be handed out as ephemeral ports: a
# collision keeps mediasoup from starting (docker/SELFHOST.md)
net.ipv4.ip_local_reserved_ports = 40000-40099
# Valkey's background saves fork; without overcommit a large instance can fail
# to fork and stop persisting
vm.overcommit_memory = 1"
  write_file "$SYSCTL_FILE" 644 "$content"
  [ $? = 2 ] && return
  # the running values count, whether or not the file was just written
  # (another file in /etc/sysctl.d may override them, or they were changed)
  local reserved overcommit
  sysctl_active() {
    reserved="$(cat /proc/sys/net/ipv4/ip_local_reserved_ports 2>/dev/null)"
    overcommit="$(cat /proc/sys/vm/overcommit_memory 2>/dev/null)"
    [[ ",$reserved," == *",40000-40099,"* ]] && [ "$overcommit" = 1 ]
  }
  if sysctl_active; then
    ok "active: ip_local_reserved_ports=$reserved, overcommit_memory=$overcommit"
    return
  fi
  change "load $SYSCTL_FILE (now: ip_local_reserved_ports='${reserved}', overcommit_memory=${overcommit})"
  if $DRY_RUN; then
    run sysctl -p "$SYSCTL_FILE"
    return
  fi
  sysctl -q -p "$SYSCTL_FILE" 2>&1 | sed 's/^/            /'
  if sysctl_active; then
    ok "active: ip_local_reserved_ports=$reserved, overcommit_memory=$overcommit"
  else
    fail "not active after loading: ip_local_reserved_ports='${reserved}', overcommit_memory=${overcommit} (a later file in /etc/sysctl.d overrides it, or no permission)"
  fi
}

# --------------------------------------------------------------------- logs
part_logs() {
  skipped logs && return 0
  say "== host logs"
  ensure_packages logrotate || fail "installing logrotate"
  local content
  content="# Common Ground self-host (docker/selfhost/harden.sh): bounded journal
[Journal]
SystemMaxUse=1G
MaxRetentionSec=4week"
  if write_file "$JOURNALD_DROPIN" 644 "$content"; then
    if has_systemd; then
      run systemctl restart systemd-journald || fail "restarting systemd-journald"
    else
      warn "no systemd: journald picks the setting up at its next start"
    fi
  fi
}

# ----------------------------------------------------------------- upgrades
part_upgrades() {
  skipped upgrades && return 0
  say "== unattended security upgrades"
  ensure_packages unattended-upgrades || { fail "installing unattended-upgrades"; return; }
  # the origins stay the distribution's default (50unattended-upgrades:
  # security updates)
  local content
  content='// Common Ground self-host (docker/selfhost/harden.sh)
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";'
  write_file "$AUTO_UPGRADES" 644 "$content"
  # Updating the container runtime restarts dockerd and with it every
  # container — that happens by hand, in a maintenance window. Docker's own
  # repository is not among the default origins anyway; the distribution's
  # docker.io/containerd/runc are (as security updates), hence the list.
  # Entries are matched as regular expressions against the package name.
  content='// Common Ground self-host (docker/selfhost/harden.sh): the container
// runtime is updated by hand (restarting it restarts every container)
Unattended-Upgrade::Package-Blacklist {
    "^docker\.io$";
    "^docker-ce";
    "^docker-buildx-plugin$";
    "^docker-compose-plugin$";
    "^containerd";
    "^runc$";
};'
  write_file "$UPGRADES_BLACKLIST" 644 "$content"
  if has_systemd && ! $DRY_RUN; then
    systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || warn "could not enable unattended-upgrades.service"
  fi
  if [ -f /var/run/reboot-required ]; then
    warn "a reboot is pending (/var/run/reboot-required) — updates are installed without rebooting"
  fi
}

# ----------------------------------------------------------------- firewall
# port of an address as sshd, ss and systemd print it: 0.0.0.0:22, [::]:22, *:22, 22
port_of() {
  local a="${1%% *}"
  a="${a##*:}"
  [[ "$a" =~ ^[0-9]+$ ]] && echo "$a"
}

# sorted unique list of the words on stdin
uniq_words() { tr ' ' '\n' | grep -E '^[0-9]+$' | sort -un | tr '\n' ' ' | sed 's/ $//'; }

# The TCP ports to keep open for SSH. Four sources, which must agree:
#   config      `sshd -T` listenaddress lines (they carry the port for every
#               ListenAddress, the Port settings included)
#   listening   sockets sshd listens on (ss), plus an active ssh.socket
#               (socket activation: the ports systemd listens on for sshd)
#   in use      the server port of this session ($SSH_CONNECTION) and of every
#               established sshd connection
# Sets SSH_PORTS; fails with SSH_PORTS_REASON when they cannot be determined
# or disagree — the firewall is then not touched, since a wrong guess cuts
# the operator off. (Run in this shell, not in $(...), for the two globals.)
SSH_PORTS=""
SSH_PORTS_REASON=""
ssh_ports() {
  if ! command -v sshd >/dev/null 2>&1; then
    SSH_PORTS_REASON="no openssh-server: allowing 22/tcp only"
    SSH_PORTS=22
    return 0
  fi
  if ! command -v ss >/dev/null 2>&1; then
    SSH_PORTS_REASON="ss (iproute2) is missing, so sshd's listening ports cannot be checked"
    return 1
  fi
  local config listening inuse sockports=""
  config="$(sshd -T 2>/dev/null | awk '$1 == "listenaddress" { print $2 }' | while read -r a; do port_of "$a"; done | tr '\n' ' ' | uniq_words)"
  if [ -z "$config" ]; then
    SSH_PORTS_REASON="sshd -T failed (invalid sshd configuration?)"
    return 1
  fi
  listening="$(ss -Hltnp 2>/dev/null | awk '/users:\(\("sshd/ { print $4 }' | while read -r a; do port_of "$a"; done | tr '\n' ' ')"
  if has_systemd && systemctl is-active --quiet ssh.socket 2>/dev/null; then
    sockports="$(systemctl show -p Listen ssh.socket 2>/dev/null | sed -n 's/^Listen=//p' | tr ' ' '\n' | grep -v '^(' | while read -r a; do port_of "$a"; done | tr '\n' ' ')"
  fi
  listening="$(echo "$listening $sockports" | uniq_words)"
  inuse="$(echo "${SSH_CONNECTION:-}" | awk 'NF == 4 { print $4 }') $(ss -Htnp state established 2>/dev/null | awk '/users:\(\("sshd/ { print $3 }' | while read -r a; do port_of "$a"; done | tr '\n' ' ')"
  inuse="$(echo "$inuse" | uniq_words)"
  if [ -z "$listening" ]; then
    SSH_PORTS_REASON="nothing listens for sshd (configured: $config) — start ssh, or skip the firewall part"
    return 1
  fi
  if [ "$config" != "$listening" ]; then
    SSH_PORTS_REASON="sshd's configuration names port(s) $config, but it listens on $listening${sockports:+ (ssh.socket: $sockports)} — restart ssh or align the configuration first"
    return 1
  fi
  local p
  for p in $inuse; do
    if [[ " $listening " != *" $p "* ]]; then
      SSH_PORTS_REASON="an SSH session uses port $p, which sshd does not listen on ($listening) — a forwarded port? Not touching the firewall"
      return 1
    fi
  done
  SSH_PORTS_REASON="configured and listening: $listening${inuse:+; sessions on: $inuse}"
  SSH_PORTS="$listening"
}

# published host ports of running containers that the firewall rules do not
# cover — Docker puts them in front of ufw, so they are open regardless
check_published_ports() {
  command -v docker >/dev/null 2>&1 || { ok "docker not installed yet: no published ports to check"; return; }
  local lines
  if ! lines="$(docker ps --format '{{.Names}}	{{.Ports}}' 2>/dev/null)"; then
    warn "cannot list containers (docker ps failed) — check published ports yourself"
    return
  fi
  local extra=0 seen=" " name ports p addr hostport proto lo hi
  while IFS=$'\t' read -r name ports; do
    [ -n "$ports" ] || continue
    for p in ${ports//,/ }; do
      case "$p" in *'->'*) ;; *) continue ;; esac
      addr="${p%%->*}"; proto="${p##*/}"
      # loopback-only bindings are not reachable from outside
      case "$addr" in 127.*|'[::1]':*) continue ;; esac
      hostport="${addr##*:}"; addr="${addr%:*}"
      if [[ " $ALLOWED_PUBLISHED " == *" $hostport/$proto "* ]]; then continue; fi
      if [[ "$hostport" =~ ^[0-9]+(-[0-9]+)?$ ]]; then
        lo="${hostport%-*}"; hi="${hostport#*-}"
        if [ "$lo" -ge 40000 ] && [ "$hi" -le 40099 ]; then continue; fi
      fi
      # one line per container and port (IPv4 and IPv6 bindings come separately)
      [[ "$seen" == *" $name:$hostport/$proto "* ]] && continue
      seen="$seen$name:$hostport/$proto "
      warn "container $name publishes $hostport/$proto (on $addr): Docker opens it past ufw — publish it on 127.0.0.1 or not at all"
      extra=1
    done
  done <<< "$lines"
  [ "$extra" = 0 ] && ok "no container publishes a port outside the allowed set"
}

# Docker 28+ can program its rules through nftables instead of iptables; ufw
# (iptables-nft) and Docker's own nftables tables are then evaluated
# separately, and the interplay — published ports, container traffic through
# ufw's forward policy — is not what this setup was tested with
check_docker_firewall_backend() {
  command -v docker >/dev/null 2>&1 || return 0
  local backend
  backend="$(docker info --format '{{with .FirewallBackend}}{{.Driver}}{{end}}' 2>/dev/null)" || return 0
  case "$backend" in
    *nftables*) warn "Docker uses its nftables firewall backend ($backend): not tested with ufw here — check that published ports and container egress behave (docs/deployment §3.11)" ;;
    "") ;;
    *) ok "Docker firewall backend: $backend" ;;
  esac
}

part_firewall() {
  skipped firewall && return 0
  say "== firewall (ufw)"
  # SSH first, so enabling the firewall never cuts the operator off
  local sshports
  if ! $IS_ROOT; then
    sshports=22
    warn "not root: cannot check sshd's ports or read the ufw rules — 22/tcp and every rule are listed unverified"
  elif ! ssh_ports; then
    fail "refused: cannot tell which port(s) SSH needs — $SSH_PORTS_REASON. The firewall is left as it is."
    return
  else
    sshports="$SSH_PORTS"
    ok "SSH port(s): $sshports ($SSH_PORTS_REASON)"
  fi
  ensure_packages ufw || { fail "installing ufw"; return; }
  # IPv6 rules: ufw keeps them only with IPV6=yes; with no it leaves IPv6
  # unfiltered. Switch it before any rule is added.
  local readd=false
  if [ -f "$UFW_DEFAULTS" ] && grep -qE '^IPV6=no' "$UFW_DEFAULTS"; then
    # A running ufw has no IPv6 chains, and once the setting says yes it
    # rejects every command until it is started again: stop it first (while
    # the setting still matches), switch, and enable it again at the end of
    # this part. Existing connections are not affected.
    if $IS_ROOT && ufw status 2>/dev/null | grep -q '^Status: active'; then
      change "stop ufw for the IPv6 switch (enabled again below)"
      run ufw --force disable >/dev/null || { fail "ufw disable"; return; }
    fi
    change "set IPV6=yes in $UFW_DEFAULTS (with no, ufw leaves IPv6 unfiltered and adds no IPv6 rules)"
    if ! $DRY_RUN; then
      sed -i 's/^IPV6=no/IPV6=yes/' "$UFW_DEFAULTS" || { fail "could not edit $UFW_DEFAULTS"; return; }
    fi
    readd=true
  fi
  local port rule added=""
  if command -v ufw >/dev/null 2>&1 && $IS_ROOT && ! $readd; then
    added="$(ufw show added 2>/dev/null)"
  fi
  for port in $sshports; do
    if grep -qE "^ufw allow ${port}/tcp$" <<< "$added"; then
      ok "allowed: ${port}/tcp (SSH)"
    else
      change "allow ${port}/tcp (SSH)"
      run ufw allow "${port}/tcp" >/dev/null || fail "ufw allow ${port}/tcp"
    fi
  done
  for rule in "${FIREWALL_RULES[@]}"; do
    if grep -qE "^ufw allow ${rule}$" <<< "$added"; then
      ok "allowed: $rule"
    else
      change "allow $rule"
      run ufw allow "$rule" >/dev/null || fail "ufw allow $rule"
    fi
  done
  local status=""
  if $IS_ROOT && command -v ufw >/dev/null 2>&1; then
    status="$(ufw status verbose 2>/dev/null)"
  fi
  if grep -q "Default: deny (incoming)" <<< "$status"; then
    ok "default incoming policy: deny"
  else
    change "default incoming policy: deny (outgoing: allow)"
    run ufw default deny incoming >/dev/null || fail "ufw default deny incoming"
    run ufw default allow outgoing >/dev/null || fail "ufw default allow outgoing"
  fi
  if grep -q "^Status: active" <<< "$status"; then
    if $readd; then
      change "enable ufw again (with its IPv6 chains)"
      run ufw --force enable >/dev/null || fail "ufw enable"
    else
      ok "ufw is active"
    fi
  else
    change "enable ufw"
    run ufw --force enable >/dev/null || fail "ufw enable"
  fi
  check_published_ports
  check_docker_firewall_backend
}

# ---------------------------------------------------------------------- ssh
# the authorized-key files sshd uses for the operator (as it resolves them)
operator_key_files() {
  local home files f
  home="$(getent passwd "$SSH_USER" | cut -d: -f6)"
  [ -n "$home" ] || return 1
  files="$(sshd -T -C "user=$SSH_USER,host=localhost,addr=127.0.0.1" 2>/dev/null | awk '$1 == "authorizedkeysfile" { $1 = ""; print }')"
  files="${files:-.ssh/authorized_keys .ssh/authorized_keys2}"
  for f in $files; do
    [ "$f" = none ] && continue
    f="${f//%h/$home}"; f="${f//%u/$SSH_USER}"; f="${f//%%/%}"
    case "$f" in /*) ;; *) f="$home/$f" ;; esac
    [ -e "$f" ] && echo "$f"
  done
}

# number of keys in a file that open a shell: valid, and not bound to a
# forced command (command="…"), which would replace the login shell
usable_keys() {
  local tmp n
  tmp="$(mktemp)"
  # a line with options does not start with the key type; the options are
  # everything before " <type> AAAA…" — drop the line if they hold command=
  awk '/^[[:space:]]*(#|$)/ { next }
       { line = $0; sub(/^[[:space:]]+/, "", line)
         if (line ~ /^(ssh-|ecdsa-|sk-)/) { print line; next }
         i = match(line, /[[:space:]](ssh-|ecdsa-|sk-)[^[:space:]]+[[:space:]]+AAAA/)
         opts = (i > 0) ? substr(line, 1, i) : line
         if (tolower(opts) ~ /(^|,)command=/) next
         print line }' "$1" 2>/dev/null > "$tmp"
  n="$(ssh-keygen -l -f "$tmp" 2>/dev/null | wc -l)"
  rm -f "$tmp"
  echo "$n"
}

# StrictModes: sshd ignores a key file whose file, directory or home is
# writable by others or owned by someone else
strict_modes_problem() {
  local f="$1" p owner mode
  for p in "$f" "$(dirname "$f")" "$(getent passwd "$SSH_USER" | cut -d: -f6)"; do
    owner=""
    read -r owner mode < <(stat -c '%U %a' "$p" 2>/dev/null)
    [ -n "${owner:-}" ] || { echo "$p: cannot stat"; return 0; }
    if [ "$owner" != "$SSH_USER" ] && [ "$owner" != root ]; then
      echo "$p is owned by $owner"
      return 0
    fi
    if (( 8#$mode & 8#022 )); then
      echo "$p is writable by group or others (mode $mode)"
      return 0
    fi
  done
  return 1
}

# a past key login of the operator in the journal or the auth log
key_login_seen() {
  if command -v journalctl >/dev/null 2>&1 &&
     journalctl --no-pager -q -o cat --since -90d SYSLOG_IDENTIFIER=sshd SYSLOG_IDENTIFIER=sshd-session 2>/dev/null | grep -q "Accepted publickey for $SSH_USER from"; then
    return 0
  fi
  local log
  for log in /var/log/auth.log /var/log/auth.log.1 /var/log/secure; do
    [ -r "$log" ] && grep -q "Accepted publickey for $SSH_USER from" "$log" && return 0
  done
  return 1
}

part_ssh() {
  skipped ssh && return 0
  say "== ssh (key-only login)"
  if ! command -v sshd >/dev/null 2>&1; then
    warn "openssh-server is not installed — nothing to harden"
    return
  fi
  if ! getent passwd "$SSH_USER" >/dev/null; then
    fail "operator account '$SSH_USER' does not exist (pass --ssh-user)"
    return
  fi
  if ! $IS_ROOT; then
    warn "not root: cannot check $SSH_USER's keys and logins — a real run refuses without a usable key and a past key login"
  else
    local f n problem usable=""
    while read -r f; do
      [ -n "$f" ] || continue
      n="$(usable_keys "$f")"
      [ "$n" -gt 0 ] || continue
      if [ "$(sshd -T 2>/dev/null | awk '$1 == "strictmodes" { print $2 }')" != no ] && problem="$(strict_modes_problem "$f")"; then
        warn "$f is ignored by sshd (StrictModes): $problem"
        continue
      fi
      usable="$usable $f ($n key(s))"
    done < <(operator_key_files)
    if [ -z "$usable" ]; then
      fail "refused: '$SSH_USER' has no usable authorized SSH key (none at all, only keys bound to a forced command, or a file sshd ignores), so password login stays on. Add your public key to ~$SSH_USER/.ssh/authorized_keys, log in with it once, then run this again (or --ssh-user <account>)."
      return
    fi
    ok "usable authorized key(s) for $SSH_USER:$usable"
    if $LOGIN_CHECK; then
      if key_login_seen; then
        ok "a key login of $SSH_USER is in the logs"
      else
        fail "refused: no \"Accepted publickey for $SSH_USER\" in the journal or auth log — log in with your key once (a second terminal), then run this again (--no-login-check skips this check)"
        return
      fi
    fi
  fi
  if ! grep -qiE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config 2>/dev/null; then
    fail "/etc/ssh/sshd_config does not include /etc/ssh/sshd_config.d/*.conf — set PasswordAuthentication no there yourself"
    return
  fi
  # Root login is restricted only where it was fully open: a stricter value
  # (no, forced-commands-only) stays. Kept once written, so a second run does
  # not drop the line it added itself.
  local rootline=""
  if grep -qE '^PermitRootLogin ' "$SSHD_DROPIN" 2>/dev/null; then
    rootline="PermitRootLogin prohibit-password"
  elif $IS_ROOT && [ "$(sshd -T -C "user=root,host=localhost,addr=127.0.0.1" 2>/dev/null | awk '$1 == "permitrootlogin" { print $2 }')" = yes ]; then
    rootline="PermitRootLogin prohibit-password"
  fi
  # sshd takes the FIRST value it reads for each option: 10- sorts before the
  # 50-cloud-init.conf that cloud images ship with PasswordAuthentication yes
  local content
  content="# Common Ground self-host (docker/selfhost/harden.sh): key-only login
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no${rootline:+
$rootline}"
  write_file "$SSHD_DROPIN" 644 "$content"
  local rc=$?
  [ $rc = 2 ] && return
  if [ $rc = 0 ] && ! $DRY_RUN; then
    if ! sshd -t; then
      rm -f "$SSHD_DROPIN"
      fail "sshd -t rejected the configuration — removed $SSHD_DROPIN again"
      return
    fi
    if has_systemd; then
      systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || warn "could not reload sshd — it applies the setting at its next start"
    else
      warn "no systemd: reload sshd yourself"
    fi
  fi
  if $IS_ROOT && ! $DRY_RUN; then
    local effective
    effective="$(sshd -T -C "user=$SSH_USER,host=localhost,addr=127.0.0.1" 2>/dev/null | awk '$1 ~ /^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin)$/ { printf "%s=%s ", $1, $2 }')"
    if [[ "$effective" == *"passwordauthentication=no"* ]] && [[ "$effective" == *"kbdinteractiveauthentication=no"* ]] && [[ "$effective" != *"permitrootlogin=yes"* ]]; then
      ok "effective: $effective"
    else
      fail "effective sshd settings are not key-only: $effective (another file in sshd_config.d sorts first?)"
    fi
    say "            Keep this session open and test a new SSH login in a second terminal."
  fi
}

part_sysctl
part_logs
part_upgrades
part_firewall
part_ssh

say ""
if [ "$FAILED" != 0 ]; then
  say "Done with failures (see [FAILED] above)."
  exit 1
fi
if [ "$CHANGES" = 0 ]; then
  say "Everything is in place — nothing to change."
elif $DRY_RUN; then
  say "$CHANGES change(s) would be made. Run without --dry-run (as root) to apply them."
else
  say "$CHANGES change(s) made."
fi
if [ "$WARNINGS" != 0 ]; then
  say "$WARNINGS warning(s) — see [warn] above."
fi
exit 0
