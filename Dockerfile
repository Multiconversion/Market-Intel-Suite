# Imagen base oficial de Node.js
FROM node:18

# Crea el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copia package.json y package-lock.json primero (mejora caché de dependencias)
COPY package*.json ./

# Instala dependencias (solo producción)
RUN npm install --omit=dev

# 👇 Asegura que se copie tu carpeta data al contenedor
COPY data ./data

# Copia el resto del código fuente
COPY . .

# Expone el puerto de la app
EXPOSE 3000

# Comando por defecto para iniciar el servicio
CMD ["npm", "start"]

