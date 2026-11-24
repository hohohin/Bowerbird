#!/usr/bin/env bash
set -Eeuo pipefail
home=/var/lib/bowerbird-mcp
[[ $EUID == 0 && -f $home/.managed-by-bowerbird-mcp ]] || { echo 'Managed MCP installation required.' >&2; exit 1; }
enabled=/etc/nginx/sites-enabled/bowerbird-mcp
if [[ -L $enabled ]]; then
    [[ $(readlink "$enabled") == /etc/nginx/sites-available/bowerbird-mcp ]]
    rm -- "$enabled"
fi
nginx -t
systemctl reload nginx
rm -f -- "$home/.ssh/authorized_keys"
# Terminate only this dedicated forwarding account's connections.
if id bowerbird-mcp >/dev/null 2>&1; then
    pkill -u bowerbird-mcp || true
    userdel bowerbird-mcp
fi
rm -f -- /etc/ssh/sshd_config.d/90-bowerbird-mcp.conf
sshd -t
systemctl reload ssh
rm -f -- /etc/nginx/sites-available/bowerbird-mcp /etc/nginx/snippets/bowerbird-mcp-proxy.conf
printf 'MCP site and forwarding access disabled. Retained ACME certificate and deployment evidence at %s for review.\n' "$home"
