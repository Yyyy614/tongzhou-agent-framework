#!/usr/bin/env bash
# Atomically update only the isolated staging console; no container restart.
set -Eeuo pipefail
ROOT=/srv/company-agent-staging
APP=caf-staging-app
test "$(readlink -f "$PWD")" = "$ROOT"
test "$(cat .project-scope)" = company-agent-staging
candidate=$(readlink -f -- "${1:?Provide the uploaded console-refresh directory}")
test "$(dirname "$candidate")" = "$ROOT"
case "$(basename "$candidate")" in console-refresh-*) ;; *) exit 1 ;; esac
exec 9> .console-refresh.lock
flock -n 9
test "$(sudo -n docker inspect "$APP" --format '{{index .Config.Labels "com.company-agent.scope"}}')" = company-agent-staging
release=$(sudo -n docker inspect "$APP" --format '{{range .Mounts}}{{if eq .Destination "/app"}}{{.Source}}{{end}}{{end}}')
release=$(readlink -f -- "$release")
case "$release" in "$ROOT/release"|"$ROOT"/accounts-*/release) ;; *) exit 1 ;; esac
web="$release/web"
test "$(readlink -f "$web")" = "$web"
test -d "$web"
test ! -e "$candidate/next-web"
test "$(awk '{sub(/\r$/, "", $2); print $2}' "$candidate/SHA256SUMS" | sort)" = "$(printf 'app.js\nui.js\nviews.js\n' | sort)"
(cd "$candidate" && sha256sum -c SHA256SUMS)
for file in app.js ui.js views.js; do test -f "$candidate/$file"; test ! -L "$candidate/$file"; done
before=$(sudo -n docker inspect "$APP" --format '{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}')
cp -a "$web" "$candidate/next-web"
for file in app.js ui.js views.js; do install -m 644 "$candidate/$file" "$candidate/next-web/$file"; done
# Both directories stay within the test root. Linux exchanges their names in
# one operation; the previous web directory remains available for rollback.
exchange() {
  python3 - "$ROOT" "$web" "$candidate/next-web" <<'PY'
import ctypes, os, sys
root, first, second = map(os.path.realpath, sys.argv[1:])
assert all(os.path.commonpath([root, path]) == root and path != root and os.path.isdir(path) for path in [first, second])
libc = ctypes.CDLL(None, use_errno=True)
rename = libc.renameat2
rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
rename.restype = ctypes.c_int
if rename(-100, os.fsencode(first), -100, os.fsencode(second), 2):
    code = ctypes.get_errno()
    raise OSError(code, os.strerror(code))
PY
}
swapped=no
rollback() {
  status=$?
  trap - ERR
  if [ "$swapped" = yes ]; then exchange; printf 'Restored the previous staging console.\n' >&2; fi
  exit "$status"
}
trap rollback ERR
exchange
swapped=yes
for file in app.js ui.js views.js; do
  curl --fail --silent --show-error "http://127.0.0.1:14317/assets/$file" -o "$candidate/served-$file"
  cmp "$candidate/$file" "$candidate/served-$file"
done
curl --fail --silent --show-error http://127.0.0.1:14317/health
test "$(sudo -n docker inspect "$APP" --format '{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}')" = "$before"
trap - ERR
printf '\nStaging console updated without restarting the application.\nPrevious web files: %s/next-web\n' "$candidate"
