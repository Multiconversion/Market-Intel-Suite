FROM node:18-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm i --omit=dev

COPY server.js ./server.js
COPY openapi.yaml ./openapi.yaml
COPY templates ./templates
COPY data ./data

# security: run as non-root
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
