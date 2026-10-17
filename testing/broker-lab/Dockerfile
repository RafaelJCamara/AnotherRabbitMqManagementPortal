# Broker-lab image (M0-14): one official RabbitMQ management image per version, pinned by digest,
# plus the plugins and the configuration the conformance matrix needs.
#
#   docker build -f testing/broker-lab/Dockerfile \
#     --build-arg VERSION=4.3.6 --build-arg DIGEST=sha256:... -t broker-lab/rabbitmq:4.3.6 testing/broker-lab
#
# `nx run broker-lab:images` passes the pair from versions.json. The registry resolves the digest
# and ignores the tag, so the tag only documents what the digest is. The defaults below are the
# newest supported version and are checked against versions.json by the broker-lab spec.
ARG VERSION=4.3.6
ARG DIGEST=sha256:ca5d088daf64c9de02c923c1c57c724bf4884c5c69bfa8172c68b214c0057cea

FROM rabbitmq:${VERSION}-management@${DIGEST}

ARG VERSION
LABEL org.opencontainers.image.title="broker-lab rabbitmq" \
      org.opencontainers.image.description="RabbitMQ ${VERSION} with the broker-lab plugins and configuration" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.broker-lab.rabbitmq-version="${VERSION}"

COPY --chown=rabbitmq:rabbitmq enabled_plugins /etc/rabbitmq/enabled_plugins
COPY --chown=rabbitmq:rabbitmq rabbitmq.conf /etc/rabbitmq/conf.d/20-broker-lab.conf

# AMQP, AMQP over TLS, management, management over TLS, stream, stream over TLS, Prometheus.
EXPOSE 5672 5671 15672 15671 5552 5551 15692
