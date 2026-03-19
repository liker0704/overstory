FROM oven/bun:1-debian AS base

# System dependencies required by overstory
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    tmux \
    procps \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 (required for Claude Code CLI which is an npm package)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# os-eco CLI tools (mulch, seeds, canopy)
RUN bun install -g @os-eco/mulch-cli @os-eco/seeds-cli @os-eco/canopy-cli

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# OpenCode CLI (anomalyco/opencode)
RUN npm install -g opencode

# Overstory (our fork, from local source)
COPY package.json bun.lock /opt/overstory/
RUN cd /opt/overstory && bun install --frozen-lockfile

COPY . /opt/overstory/
RUN cd /opt/overstory && bun link

WORKDIR /workspace

# Persistent volumes for project data and claude config
VOLUME ["/workspace", "/root/.claude"]

HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
    CMD which ov && which ml && which tmux && which git

ENTRYPOINT ["/opt/overstory/docker/entrypoint.sh"]
CMD ["bash"]
