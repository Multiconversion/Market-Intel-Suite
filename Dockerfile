# ================
# 1) Builder
# ================
FROM node:18-alpine AS builder

# Evita prompts y reduce tamaño
ENV NODE_ENV=production

WORKDIR /app

# Copiamos manifests primero para cache de dependencias
COPY package*.json ./

# Instala solo deps de producción, rápido y reproducible
RUN npm ci --omit=dev

# Copiamos solo lo necesario para runtime
# (server, datos y openapi si lo sirves como estático)
COPY server.js ./server.js
COPY data ./data

# ================
# 2) Runtime
# ================
FROM node:18-alpine AS runtime

# Crear usuario no-root y carpetas con permisos correctos
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copiar node_modules y código ya preparado del builder
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/server.js ./server.js
COPY --from=builder --chown=app:app /app/data ./data

# Variables por defecto (Render las puede sobrescribir)
ENV NODE_ENV=production
ENV PORT=3000

# Salud del contenedor (wget viene en alpine)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

# Cambiar a usuario no-root
USER app

EXPOSE 3000

# Ejecutar Node directamente (menos overhead que npm start)
CMD ["node", "server.js"]
