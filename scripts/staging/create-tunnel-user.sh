#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/srv/company-agent-staging
TUNNEL_USER=caf-stage-tunnel
test "$(readlink -f "$PWD")" = "$ROOT"
test "$(cat .project-scope)" = company-agent-staging
test -s private/tunnel.pub
if id "$TUNNEL_USER" >/dev/null 2>&1; then printf 'Tunnel account already exists; refusing replacement\n' >&2; exit 1; fi
grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+ company-agent-staging-tunnel$' private/tunnel.pub
sudo -n useradd --create-home --shell /usr/sbin/nologin --comment company-agent-staging "$TUNNEL_USER"
sudo -n install -d -m 700 -o "$TUNNEL_USER" -g "$TUNNEL_USER" /home/"$TUNNEL_USER"/.ssh
# No command execution, PTY, agent or X11 forwarding. Forward targets/listeners
# are limited to this test project's loopback port, never production services.
{ printf 'restrict,port-forwarding,permitopen="127.0.0.1:14317",permitlisten="127.0.0.1:14317",command="/bin/false" '; cat private/tunnel.pub; } |
  sudo -n tee /home/"$TUNNEL_USER"/.ssh/authorized_keys >/dev/null
sudo -n chown "$TUNNEL_USER:$TUNNEL_USER" /home/"$TUNNEL_USER"/.ssh/authorized_keys
sudo -n chmod 600 /home/"$TUNNEL_USER"/.ssh/authorized_keys
printf 'Created test-only forwarding account; existing SSH settings unchanged.\n'
