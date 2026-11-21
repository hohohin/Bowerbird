#!/usr/bin/env bash
set -Eeuo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
bundle=$PWD
home=/var/lib/bowerbird-mcp
site=/etc/nginx/sites-available/bowerbird-mcp
enabled=/etc/nginx/sites-enabled/bowerbird-mcp
sshd=/etc/ssh/sshd_config.d/90-bowerbird-mcp.conf
snippet=/etc/nginx/snippets/bowerbird-mcp-proxy.conf
[[ $EUID == 0 ]] || { echo 'Run with sudo after deployment approval.' >&2; exit 1; }
sha256sum --check SHA256SUMS
[[ $(ssh-keygen -l -f tunnel.pub | wc -l) == 1 ]]
grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$' tunnel.pub
[[ $(wc -l < tunnel.pub) == 1 ]]
[[ ! -e $home && ! -e $site && ! -L $enabled && ! -e $sshd && ! -e $snippet ]]
[[ ! -e /etc/letsencrypt/live/mcp.bowerbird.cn ]]
! getent passwd bowerbird-mcp >/dev/null
! ss -ltnH 'sport = :48732' | grep -q .
getent ahostsv4 mcp.bowerbird.cn | awk '{print $1}' | grep -qx 106.55.44.143
nginx -t
sshd -t
command -v certbot >/dev/null

# Only the dedicated site's paths are installed. Website and Worker services stay active.
install -d -m 755 "$home" "$home/acme" "$home/deploy"
install -m 600 ./* "$home/deploy/"
touch "$home/.managed-by-bowerbird-mcp"
trap 'echo "Activation failed; disabling the dedicated MCP site." >&2; bash "$bundle/rollback.sh"' ERR
useradd --system --home-dir "$home" --shell /usr/sbin/nologin bowerbird-mcp
install -d -m 755 "$home/.ssh"
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:48732" %s\n' "$(cat tunnel.pub)" > "$home/.ssh/authorized_keys"
chmod 644 "$home/.ssh/authorized_keys"
install -m 644 90-bowerbird-mcp.conf "$sshd"
sshd -t
systemctl reload ssh

install -m 644 bowerbird-mcp-proxy.conf "$snippet"
install -m 644 bootstrap.nginx.conf "$site"
ln -s "$site" "$enabled"
nginx -t
systemctl reload nginx
certbot certonly --webroot -w "$home/acme" --cert-name mcp.bowerbird.cn -d mcp.bowerbird.cn --non-interactive
install -m 644 mcp.bowerbird.cn.nginx.conf "$site"
nginx -t
systemctl reload nginx
trap - ERR
printf 'MCP frontend installed. Start the local restricted HTTP service and SSH tunnel, then verify public metadata and OAuth.\n'
