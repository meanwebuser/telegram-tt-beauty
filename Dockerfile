FROM node:24-bookworm AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
ARG TELEGRAM_API_ID
ARG TELEGRAM_API_HASH
ENV TELEGRAM_API_ID=${TELEGRAM_API_ID}
ENV TELEGRAM_API_HASH=${TELEGRAM_API_HASH}
RUN npm run build:production

FROM node:24-alpine AS proxy

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY proxy ./proxy
ENV PORT=7777
ENV LISTEN_HOST=0.0.0.0
EXPOSE 7777
CMD ["node", "proxy/src/index.js"]

FROM nginx:1.27-alpine AS web

COPY deploy/nginx/container.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
RUN chmod -R a+rX /usr/share/nginx/html
EXPOSE 80
