FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/relay-fence-broker/package.json apps/relay-fence-broker/package.json
RUN pnpm install --frozen-lockfile
COPY apps/relay-fence-broker apps/relay-fence-broker
RUN pnpm --filter @orca-cloud/relay-fence-broker build

FROM hashicorp/terraform:1.15.8@sha256:7ae513256f7ce67879e218ae8593d6fbe216ec9e123abe6c94e4e10704857963 AS terraform

FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:slim@sha256:be4876b4311056bf3ce236a14a7dea1288e70b7cfea2454ea15e4165c819921f
ARG ORCA_RELAY_FENCE_IMAGE_COMMIT
RUN test "$(printf '%s' "${ORCA_RELAY_FENCE_IMAGE_COMMIT}" | grep -E '^[a-f0-9]{40}$')"
ENV NODE_ENV=production
ENV PORT=8080
ENV ORCA_RELAY_FENCE_IMAGE_COMMIT=${ORCA_RELAY_FENCE_IMAGE_COMMIT}
ENV IAC_TOOL=terraform
WORKDIR /workspace
COPY --from=build /usr/local /usr/local
COPY --from=terraform /bin/terraform /usr/local/bin/terraform
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/relay-fence-broker/package.json apps/relay-fence-broker/package.json
COPY --from=build /workspace/apps/relay-fence-broker/dist apps/relay-fence-broker/dist
COPY dev/scripts dev/scripts
COPY infra/terraform infra/terraform
RUN corepack enable \
  && pnpm install --prod --frozen-lockfile --filter @orca-cloud/relay-fence-broker... \
  && useradd --create-home --uid 10001 broker \
  && chown -R broker:broker /workspace
USER broker
EXPOSE 8080
CMD ["node", "apps/relay-fence-broker/dist/index.js"]
