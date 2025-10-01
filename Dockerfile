# ==========================
# 1) Builder
# ==========================
FROM node:18-alpine AS builder

WORKDIR /app

# Copiar manifest de dependencias
COPY package*.json ./

# Instalar dependencias de producción
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

# Copiar node_modules y código desde builder
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/server.js ./server.js
COPY --from=builder --chown=app:app /app/data ./data

# Variables de entorno por defecto
ENV NODE_ENV=production
ENV PORT=3000

# Healthcheck para Render
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

# Ejecutar como usuario no-root
USER app

EXPOSE 3000

# Ejecutar el servidor
CMD ["node", "server.js"]
