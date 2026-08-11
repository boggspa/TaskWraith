# TaskWraith standalone relay — optionally a Tier-2 APNs gateway.
#
# The .p8 signing key is NEVER copied into an image layer (design §4.3 /
# §8.5): mount it at runtime as a secret and point
# TASKWRAITH_RELAY_APNS_KEY_PATH at the mount. Without the key envs the
# gateway runs sender-less (registrations accepted, triggers dropped), and
# without TASKWRAITH_RELAY_APNS_GATEWAY=1 this is the plain blind relay.
#
#   docker build -f relay/Dockerfile -t taskwraith-relay .
#   docker run -p 8787:8787 \
#     -e TASKWRAITH_RELAY_APNS_GATEWAY=1 \
#     -e TASKWRAITH_RELAY_APNS_KEY_PATH=/run/secrets/apns_key \
#     -e TASKWRAITH_RELAY_APNS_KEY_ID=XXXXXXXXXX \
#     -e TASKWRAITH_RELAY_APNS_TEAM_ID=8CZML8FK2D \
#     -v taskwraith-relay-tokens:/data \
#     -e TASKWRAITH_RELAY_APNS_TOKENS_PATH=/data/apns-tokens.json \
#     --secret apns_key \
#     taskwraith-relay

FROM node:22-slim AS runtime
WORKDIR /app

# The relay needs ws + tsx and the shared keyless protocol modules only.
COPY package.json package-lock.json ./
COPY relay/package.json relay/
RUN npm ci --omit=dev --ignore-scripts && npm install --no-save tsx@4

COPY relay/src relay/src
COPY src/shared/e2ee src/shared/e2ee
COPY src/shared/apns src/shared/apns

ENV PORT=8787
EXPOSE 8787
USER node

CMD ["npx", "tsx", "relay/src/cli.ts"]
