# =====================
# 1. Stage de build
# =====================
FROM node:18 AS builder

WORKDIR /app

# Copiar manifest y lock para instalar dependencias
COPY package*.json ./

# Instalar TODAS las dependencias (incluyendo dev si algún script lo necesita)
RUN npm install

# Copiar el resto del código fuente (incluyendo carpeta data/)
COPY . .

# =====================
# 2. Stage final (runtime)
# =====================
FROM node:18-slim AS runtime

WORKDIR /app

# Copiar solo lo necesario desde el builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/data ./data

# Variables de entorno por defecto (se pueden sobreescribir en Render)
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Comando por defecto
CMD ["npm", "start"]
