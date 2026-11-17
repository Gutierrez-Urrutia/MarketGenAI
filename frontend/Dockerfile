# Imagen de producción del frontend: compila con Vite y sirve el resultado con nginx (Cloud Run).
# La dirección de la API se fija al compilar (VITE_API_URL), porque Vite la incrusta en el bundle.

# ── Etapa 1: compilar ────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# ── Etapa 2: servir ──────────────────────────────────────────────────────────
FROM nginx:1.27-alpine
# nginx reemplaza ${PORT} en las plantillas de /etc/nginx/templates al arrancar (Cloud Run define PORT).
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
