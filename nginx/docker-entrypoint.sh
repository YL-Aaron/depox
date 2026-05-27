#!/bin/sh
set -eu

if [ -z "${NGINX_BASIC_AUTH_USER:-}" ] || [ -z "${NGINX_BASIC_AUTH_PASSWORD:-}" ]; then
  echo "NGINX_BASIC_AUTH_USER and NGINX_BASIC_AUTH_PASSWORD must be set." >&2
  exit 1
fi

if [ ! -f /etc/nginx/certs/fullchain.pem ] || [ ! -f /etc/nginx/certs/privkey.pem ]; then
  echo "TLS certificate files /etc/nginx/certs/fullchain.pem and /etc/nginx/certs/privkey.pem are required." >&2
  exit 1
fi

htpasswd -bc /etc/nginx/.htpasswd "$NGINX_BASIC_AUTH_USER" "$NGINX_BASIC_AUTH_PASSWORD"
envsubst '${NGINX_SERVER_NAME}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf

exec nginx -g "daemon off;"
