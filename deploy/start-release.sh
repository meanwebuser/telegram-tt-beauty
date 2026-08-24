#!/bin/sh

set -eu

: "${PORT:=10000}"
sed "s|\${PORT}|${PORT}|g" /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf

PROXY_PORT=7777 node /app/proxy/src/index.js &
proxy_pid=$!

trap 'kill "$proxy_pid" 2>/dev/null || true' INT TERM EXIT

nginx -g 'daemon off;'
