# ============================
# Etapa de build
# ============================
FROM node:20-alpine AS builder

# Crear directorio de trabajo
WORKDIR /app

# Copiar package.json y package-lock.json si existe
COPY package*.json ./

# Instalar dependencias (sin dev)
RUN npm install --omit=dev

# Copiar el resto del código
COPY . .

# ============================
# Etapa de runtime
# ============================
FROM node:20-alpine AS runtime

# Crear un usuario sin privilegios
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copiar node_modules desde el builder
COPY --from=builder /app/node_modules ./node_modules

# Copiar package.json (útil para introspección)
COPY --from=builder /app/package*.json ./

# Copiar código fuente
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/data ./data

# Ajustar permisos
RUN chown -R app:app /app

USER app

# Exponer puerto (Render usará $PORT automáticamente)
EXPOSE 3000

# Comando de inicio
CMD ["node", "server.js"]
