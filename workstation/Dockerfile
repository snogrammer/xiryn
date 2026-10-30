# syntax=docker/dockerfile:1

# The machine every Xiryn agent works on: a Linux desktop with a real browser,
# streamed over noVNC, plus the everyday developer tools. Xiryn builds it once
# on your computer (`npm run setup`, or on first use) and runs one container
# per agent from it.

FROM debian:trixie-slim

# Downloads are verified against these digests (SHASUMS256.txt on nodejs.org,
# the release assets' digests on GitHub). Bump the digests with the versions.
ARG NODE_VERSION=24.20.0
ARG NODE_SHA256_X64=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
ARG NODE_SHA256_ARM64=5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7
ARG CLOUDFLARED_VERSION=2026.9.1
ARG CLOUDFLARED_SHA256_AMD64=03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc
ARG CLOUDFLARED_SHA256_ARM64=3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    DISPLAY=:1 \
    XIRYN_SCREEN=1280x800 \
    PIP_BREAK_SYSTEM_PACKAGES=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify xdotool scrot x11-utils x11-xserver-utils dbus-x11 \
      xfwm4 xfce4-panel xfce4-settings xfconf xfce4-terminal thunar \
      adwaita-icon-theme gnome-themes-extra feh \
      chromium fonts-noto-core fonts-noto-color-emoji fonts-liberation fonts-dejavu-core \
      bash-completion ca-certificates curl wget git jq less nano procps iproute2 \
      sudo tini tzdata unzip zip xz-utils openssh-client \
      python3 python3-pip python3-venv python-is-python3 \
 && rm -rf /var/lib/apt/lists/*

# Node.js from the official build (Debian's is older and pulls in hundreds of
# packages), and cloudflared for temporary take-over links
RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) node_arch=x64;   node_sha="$NODE_SHA256_X64";   cloudflared_sha="$CLOUDFLARED_SHA256_AMD64" ;; \
      arm64) node_arch=arm64; node_sha="$NODE_SHA256_ARM64"; cloudflared_sha="$CLOUDFLARED_SHA256_ARM64" ;; \
      *) echo "unsupported: $arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/node.tar.xz \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
 && echo "${node_sha}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
      --exclude='*/README.md' --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' \
 && rm /tmp/node.tar.xz \
 && curl -fsSL -o /usr/local/bin/cloudflared \
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${arch}" \
 && echo "${cloudflared_sha}  /usr/local/bin/cloudflared" | sha256sum -c - \
 && chmod +x /usr/local/bin/cloudflared \
 && node --version && cloudflared --version

# The agent works as an ordinary user with passwordless sudo: it can install
# what a task needs, and none of it touches your computer
RUN useradd --create-home --uid 1000 --shell /bin/bash xiryn \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
 && echo 'xiryn ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/xiryn \
 && chmod 0440 /etc/sudoers.d/xiryn

COPY rootfs/ /

# Scripts must stay runnable even if a checkout converted line endings.
# Only Xiryn's own: node and cloudflared live in the same folder.
RUN sed -i 's/\r$//' /usr/local/bin/xiryn-* /usr/local/bin/browser /etc/chromium.d/xiryn \
 && chmod +x /usr/local/bin/xiryn-* /usr/local/bin/browser \
 && chown -R xiryn:xiryn /home/xiryn

USER xiryn
WORKDIR /home/xiryn
EXPOSE 6080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["xiryn-desktop"]
