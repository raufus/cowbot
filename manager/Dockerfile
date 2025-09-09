# Crowbot Manager: API + Manager Bot via PM2
FROM node:18-alpine

# Install pm2 globally
RUN npm i -g pm2

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install deps
RUN npm ci --legacy-peer-deps || npm i --legacy-peer-deps

# Copy source
COPY . .

# Ensure data dirs
RUN mkdir -p ./data/logs ./data && ls -la

# Expose API port
EXPOSE 8080

# Use PM2 to run both API and Manager bot from ecosystem
CMD ["pm2-runtime", "start", "ecosystem.config.cjs"]
