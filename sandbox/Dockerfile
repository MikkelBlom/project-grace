# Isolated build + run sandbox for Grace's self-authored tools (ROADMAP P5).
# Candidate tool code is compiled AND executed in here with NO host filesystem and
# (by default) NO network, so buggy or malicious generated code can't touch the real
# machine. See docs/auto-develop.md and scripts/sandbox-tool.mjs.
FROM node:24-alpine
WORKDIR /app

# Toolchain pinned to match the monorepo so a pass in here == a pass in the real build.
COPY sandbox/package.json ./package.json
RUN npm install --no-audit --no-fund

# The real @grace/tools framework + existing tools, so a candidate compiles for real.
COPY packages/tools/src ./src
COPY sandbox/tsconfig.json ./tsconfig.json
COPY sandbox/validate.mjs ./validate.mjs

# Pre-build the baseline once so the image ships green and candidate builds are quick.
RUN npx tsc -p tsconfig.json

ENTRYPOINT ["node", "validate.mjs"]
