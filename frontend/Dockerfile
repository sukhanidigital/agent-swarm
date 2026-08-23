# Static build served by nginx — this is the *web* deployment (see MOBILE.md for the native apps,
# which don't go through Docker at all). VITE_API_BASE_URL is a build ARG, not a runtime env var:
# Vite bakes it into the JS bundle at build time, so it has to be passed to `docker build`, not just
# `docker run` (see docker-compose.yml).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
