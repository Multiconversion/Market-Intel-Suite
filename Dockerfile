# ==========================
# 1) Builder
# ==========================
FROM node:18-alpine AS builder

WORKDIR /app

# Copiar manifests de dependencias
COPY package*.json ./

# Instalar dependencias de producción
RUN npm install --omit=dev

# Copiar el código necesario (incluida la carpeta data/)
COPY server.js ./server.js
COPY data ./data

# ==========================
# 2) Runtime
# ==========================
FROM node:18-alpine AS runtime

# Crear usuario no-root
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Instalar curl para el healthcheck
RUN apk add --no-cache curl

# Copiar artefactos desde el builder
COPY --from=builder --chown=app:app /app/package.json ./package.json
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/server.js ./server.js
COPY --from=builder --chown=app:app /app/data ./data

# Variables de entorno por defecto
ENV NODE_ENV=production
ENV PORT=3000

# Healthcheck para Render
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

# Ejecutar como usuario no-root
USER app

EXPOSE 3000

# Ejecutar el servidor (Node en modo ESM con "type":"module" en package.json)
CMD ["node", "server.js"]
