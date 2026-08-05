FROM node:24.18-bookworm
# NSFW classification model, pinned revision + sha256-verified (the runtime
# loads it from /models/nsfw and never touches the network). First layers on
# purpose: they depend on nothing but the script, so source changes don't
# re-download 87 MB from huggingface.co on every build.
COPY download_model.sh /tmp/download_model.sh
RUN sh /tmp/download_model.sh /models/nsfw && rm /tmp/download_model.sh
COPY ./dist /dist
WORKDIR /dist
RUN apt-get update &&\
    apt-get install -y build-essential python3 python3-pip &&\
    apt-get install -y ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils
RUN sed -i 's/yarnPath: .*//g' /dist/.yarnrc.yml && \
    corepack enable && \
    yarn &&\
    yarn tsc && \
    rm /dist/.yarnrc.yml && \
    # onnxruntime-node ships all platforms' prebuilt binaries and the
    # transformers dependency tree includes the browser-only onnxruntime-web —
    # drop the ~290 MB that can never run in this linux node image (verified:
    # classification works without onnxruntime-web in the node runtime)
    rm -rf /dist/node_modules/onnxruntime-node/bin/napi-v6/darwin \
           /dist/node_modules/onnxruntime-node/bin/napi-v6/win32 \
           /dist/node_modules/onnxruntime-web
RUN apt-get remove -y build-essential python3-pip &&\
    apt-get clean &&\
    apt-get autoremove --yes &&\
    rm -rf /var/lib/apt/lists/*
HEALTHCHECK --interval=20s --timeout=3s CMD bash /dist/healthcheck/healthcheck.sh