# Rivalize MCP server (stdio), for the Docker MCP Catalog and local use.
#
#   docker build -t rivalize-mcp .
#   docker run -i --rm -e RIVALIZE_API_KEY rivalize-mcp
#
# The server speaks MCP over stdin/stdout, so run it with -i and no TTY.
# RIVALIZE_API_KEY is required; RIVALIZE_API_URL and RIVALIZE_MCP_ALLOW_WRITES
# are optional (see README.md).

# --- build: compile TypeScript to dist/, then drop dev dependencies -----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# package-lock.json pins the tree. Without it, npm 10 (node:22's) fails to
# resolve vitest's optional peers, so the fallback skips peer resolution; the
# build needs only typescript, @types/node and the runtime dependencies.
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else npm install --no-audit --no-fund --legacy-peer-deps; fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund && npm cache clean --force

# --- runtime ------------------------------------------------------------------
FROM node:22-alpine
# The official MCP Registry's ownership check for an OCI package.
LABEL io.modelcontextprotocol.server.name="ai.rivalize/rivalize-mcp"
LABEL org.opencontainers.image.title="Rivalize MCP server" \
      org.opencontainers.image.description="Competitive intelligence for agents, over MCP stdio" \
      org.opencontainers.image.source="https://github.com/Downshift/rivalize-mcp" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json LICENSE ./
# node:22-alpine ships an unprivileged `node` user (uid 1000).
USER node
ENTRYPOINT ["node", "dist/index.js"]
