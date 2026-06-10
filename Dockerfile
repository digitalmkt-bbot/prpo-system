# Build stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY package.json .
RUN npm install

# Production stage
FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

EXPOSE 3000

# Railway provides its own platform healthcheck and injects PORT dynamically,
# so a Docker-level healthcheck hardcoded to port 3000 can wrongly mark the
# container unhealthy. Let the app bind to $PORT and skip the Docker healthcheck.

CMD ["node", "server.js"]
