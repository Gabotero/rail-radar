#!/usr/bin/env bash
# Publishes Rail Radar (the railradar container on 127.0.0.1:8610) at https://trainspain.duckdns.org,
# next to the other sites on this server. Only a new site file is added; the other sites' nginx
# configs are not modified.
#
# Usage: sudo bash ~/railradar/deploy/setup-nginx.sh
set -euo pipefail

DOMAIN="trainspain.duckdns.org"
UPSTREAM="127.0.0.1:8610"
# "zz-" makes nginx load this site after the game's, so the game stays the server's default site.
SITE="/etc/nginx/sites-available/zz-trainspain.conf"
ENABLED="/etc/nginx/sites-enabled/zz-trainspain.conf"

[ "$(id -u)" -eq 0 ] || { echo "Run it with sudo."; exit 1; }
[ ! -e "$ENABLED" ] || { echo "$ENABLED already exists. Nothing was changed."; exit 1; }

# 1. The name must point at this server, or no certificate can be issued.
DOMAIN_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)
if ! hostname -I | tr ' ' '\n' | grep -x "${DOMAIN_IP:-none}" > /dev/null; then
    echo "$DOMAIN points to '${DOMAIN_IP:-nothing}', not to this server. Nothing was changed."
    exit 1
fi

# 2. The app must already be running.
if ! curl -fsS --max-time 5 "http://$UPSTREAM/api/status" > /dev/null; then
    echo "Rail Radar is not answering on $UPSTREAM (start it with: cd ~/railradar && docker compose up -d)."
    echo "Nothing was changed."
    exit 1
fi

# 3. nginx site, plain HTTP for the moment (certbot adds HTTPS below).
cat > "$SITE" <<EOF
# $DOMAIN: Rail Radar (live Spanish trains), proxied to the railradar container on $UPSTREAM.
# Written by ~/railradar/deploy/setup-nginx.sh; certbot adds HTTPS to this file.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # The live stream (Server-Sent Events) is ~45 KB/s of JSON per viewer; gzip makes it ~8 KB/s.
    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_types text/event-stream application/json application/geo+json application/javascript text/javascript text/css image/svg+xml;

    location / {
        proxy_pass http://$UPSTREAM;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Live updates: must not be buffered, and stays open.
    location = /api/stream {
        proxy_pass http://$UPSTREAM;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
EOF
ln -s "$SITE" "$ENABLED"
if ! nginx -t; then
    rm -f "$ENABLED"
    echo "nginx rejected the new site; it was switched off again and nginx was not reloaded."
    exit 1
fi
systemctl reload nginx

# 4. Free HTTPS certificate. certbot adds it to this site and redirects http:// to https://.
if ! certbot --nginx -d "$DOMAIN" --redirect; then
    echo "No certificate could be issued. The site stays on plain http://$DOMAIN for now."
    exit 1
fi

echo
echo "Done. Open https://$DOMAIN"
