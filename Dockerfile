# ==========================
# 1) Builder
# ==========================
FROM node:18-alpine AS builder

WORKDIR /app

# Copiar manifests
COPY package*.json ./

# Instalar deps de producción
RUN npm install --omit=dev

# Copiar código fuente necesario
COPY server.js ./server.js
COPY data ./data

# ==========================
# 2) Runtime
# ==========================
FROM node:18-alpine AS runtime

# Crear usuario no-root
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# ⬇️ COPIAR package.json (para que Node vea "type":"module")
COPY --from=builder --chown=app:app /app/package.json ./package.json
# (opcional) si tienes package-lock.json, cópialo también:
# COPY --from=builder --chown=app:app /app/package-lock.json ./package-lock.json

# Copiar node_modules y código
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/server.js ./server.js
COPY --from=builder --chown=app:app /app/data ./data

ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

USER app
EXPOSE 3000
CMD ["node", "server.js"]
