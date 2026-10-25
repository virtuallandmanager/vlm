# Design Studio worker (spike): headless Blender 4.4, Chrome for Decentraland's wearable-preview,
# the Claude Code and Codex CLIs, and dcl-avatar-skills at a pinned commit.
# Build: docker build --platform linux/amd64 -t vlm-studio-worker:spike apps/studio-worker
FROM debian:bookworm-slim

ARG BLENDER_VERSION=4.4.3
ARG BLENDER_SHA256=8d3be07d2bc412b502c6bfe3cfe3e22195a4164076867da987ce148d73c27946
# download.blender.org sits behind a bot check; this is one of its listed mirrors, and the checksum pins the file
ARG BLENDER_MIRROR=https://mirrors.ocf.berkeley.edu/blender/release/Blender4.4
ARG SKILLS_REPO=https://github.com/MetaverseUnknower/dcl-avatar-skills.git
ARG SKILLS_SHA=3430ce2ef5b7f9d388fcb7c923f50e0dcb505420

ENV DEBIAN_FRONTEND=noninteractive PIP_BREAK_SYSTEM_PACKAGES=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg xz-utils python3 python3-pip \
      libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libegl1 libxkbcommon0 libsm6 libice6 libx11-6 libxext6 \
    && rm -rf /var/lib/apt/lists/*

# Blender
RUN curl -fsSL -o /tmp/blender.tar.xz "$BLENDER_MIRROR/blender-$BLENDER_VERSION-linux-x64.tar.xz" \
    && echo "$BLENDER_SHA256  /tmp/blender.tar.xz" | sha256sum -c - \
    && mkdir -p /opt/blender && tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1 \
    && rm /tmp/blender.tar.xz && ln -s /opt/blender/blender /usr/local/bin/blender

# Chrome (the skills' preview drives the installed Chrome channel) and Node 22
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends google-chrome-stable nodejs \
    && rm -rf /var/lib/apt/lists/*

# Python tools: numpy for the checkers, Playwright for the preview, pytest for the spike harness
RUN pip3 install --no-cache-dir numpy playwright pytest && playwright install-deps chromium

# Agent CLIs
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

# Skills, pinned, installed for both agents into the run directory
RUN git clone "$SKILLS_REPO" /opt/skills && git -C /opt/skills checkout --quiet "$SKILLS_SHA" \
    && mkdir -p /work && bash /opt/skills/install.sh claude codex --project /work

# Claude Code refuses to skip its permission prompts as root, so the agents run as an ordinary user
RUN useradd -m -u 1000 agent && chown -R agent /work

COPY smoke.sh /opt/smoke.sh
USER agent
WORKDIR /work
