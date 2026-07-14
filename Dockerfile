# syntax=docker/dockerfile:1

# ---- build stage ----------------------------------------------------------
# Full image: has the toolchain (python/make/g++) that node-gyp needs to
# compile better-sqlite3's native addon.
FROM node:22-bookworm AS build
WORKDIR /app

# Install all dependencies (dev included) against a cached layer.
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript to dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage --------------------------------------------------------
# Slim image for a small footprint. The native better-sqlite3 binary compiled
# in the build stage is reused (same Debian bookworm base → matching glibc),
# so no toolchain is needed here.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
# Drop dev dependencies now that the build is done.
RUN npm prune --omit=dev

COPY --from=build /app/dist ./dist
COPY rubrics ./rubrics

# OPENAI_API_KEY must be provided at runtime (e.g. -e OPENAI_API_KEY=... or
# --env-file). DB_PATH defaults to ./data/evaluations.db (created on boot);
# mount a volume at /app/data to persist the audit trail across runs.
EXPOSE 3000
CMD ["node", "--env-file-if-exists=.env", "dist/api/index.js"]
