#!/usr/bin/env bash
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ "$(id -u)" -ne 0 ]] || fail "Run as the dedicated unprivileged nexo user, not root."
[[ "$(uname -s)" == "Linux" ]] || fail "Linux is required."
command -v bwrap >/dev/null 2>&1 || fail "bubblewrap is missing."
command -v systemctl >/dev/null 2>&1 || fail "systemd is required for the supplied service policy."
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || fail "cgroups v2 is not mounted."
[[ -n "${NEXO_CGROUP_ROOT:-}" ]] || fail "Set NEXO_CGROUP_ROOT to the delegated service cgroup."
root="${NEXO_CGROUP_ROOT}"
[[ -f "$root/cgroup.controllers" && -f "$root/cgroup.subtree_control" ]] || fail "Delegated cgroup root is unavailable."
controllers="$(cat "$root/cgroup.subtree_control")"
for c in cpu memory pids; do
  grep -qw "$c" <<<"$controllers" || fail "cgroup controller '$c' is not enabled."
done
for f in cpu.max memory.max pids.max; do
  [[ -e "$root/$f" ]] || fail "Missing cgroup control file: $f"
done
ok "cgroups v2 controllers are delegated"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
bwrap --die-with-parent --unshare-all --ro-bind /usr /usr --proc /proc --dev /dev --tmpfs /tmp -- true   || fail "bubblewrap namespace smoke test failed"
ok "bubblewrap namespace smoke test passed"

if command -v findmnt >/dev/null 2>&1; then
  fs="$(findmnt -n -o FSTYPE -T "${NEXO_BOTS_DIR:-/opt/nexo/bots}" 2>/dev/null || true)"
  opts="$(findmnt -n -o OPTIONS -T "${NEXO_BOTS_DIR:-/opt/nexo/bots}" 2>/dev/null || true)"
  case "$fs:$opts" in
    *ext4:*prjquota*|*ext4:*project*|*xfs:*prjquota*|*xfs:*pquota*) ok "Project quota mount option detected" ;;
    *) echo "WARN: project disk quotas are NOT verified for $fs; do not host untrusted uploads." ;;
  esac
fi

echo "NOTE: This is a preflight only. It does not prove DNS/network filtering, quota enforcement, or Discord bot behavior."
echo "NOTE: Verify systemd IPAddressDeny/Allow policy with an actual blocked-private-IP test before exposing the panel."
