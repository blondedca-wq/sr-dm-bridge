#!/usr/bin/env bash
set -e
docker exec -i n8n-caddy-1 tee /etc/caddy/Caddyfile < /opt/n8n/Caddyfile > /dev/null
docker exec n8n-caddy-1 caddy reload --config /etc/caddy/Caddyfile
sleep 2
curl -s https://auto.secondring.ca/dm/health
echo
