# SentinelAI dashboard.
#
# Built by Vite into static assets, then served by nginx — which also proxies /api and
# /ws to the backend. That proxy is not a convenience: the browser cannot set an
# Authorization header on a WebSocket upgrade, so the token travels in the STOMP
# CONNECT frame and the upgrade has to reach the backend from the same origin the app
# was served from. Same-origin holds here and in dev, so one set of CORS rules covers
# both.

FROM node:20-alpine AS build
WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /build/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]