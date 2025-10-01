# ==========================
# 1) Builder
# ==========================
FROM node:18-alpine AS builder

WORKDIR /app

# Copiamos manifest(s) primero para cachear dependencias
COPY package*.json ./

# Instalar dependencias de producción (evita requisito de package-lock)
RUN npm install --omit=dev

# Copiamos el código necesario para runtime
COPY server.js ./server.js
COPY data ./data

# ==========================
# 2) Runtime
# ==========================
FROM node:18-alpine AS runtime

# Crear usuario no-root
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Instalar curl para el healthcheck (Alpine)
RUN apk add --no-cache curl

# Copiar artefactos desde el builder
# (incluimos package.json para que Node honre "type": "module")
COPY --from=builder --chown=app:app /app/package.json ./package.json
# (si tienes package-lock.json y te interesa llevarlo, descomenta)
# COPY --from=builder --chown=app:app /app/package-lock.json ./package-lock.json

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/server.js ./server.js
COPY --from=builder --chown=app:app /app/data ./data

# Variables por defecto (Render puede sobreescribir)
ENV NODE_ENV=production
ENV PORT=3000

# Healthcheck robusto: espera a que /healthz responda 200
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

# Ejecutar como usuario no-root
USER app

EXPOSE 3000

# Ejecutar el servidor (usa ESM si en package.json tienes "type":"module")
CMD ["node", "server.js"]
