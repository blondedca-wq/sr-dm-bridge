#!/usr/bin/env bash
set -e
docker cp /opt/n8n/Caddyfile n8n-caddy-1:/etc/caddy/Caddyfile
docker exec n8n-caddy-1 caddy reload --config /etc/caddy/Caddyfile
sleep 2
curl -s https://auto.secondring.ca/dm/health
echo
