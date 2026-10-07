FROM gradle:8.9.0-jdk17-jammy AS build
USER root
RUN apt-get update && apt-get install -y --no-install-recommends wget unzip ca-certificates && rm -rf /var/lib/apt/lists/*
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && wget -q -O /tmp/cmdline-tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    && unzip -q /tmp/cmdline-tools.zip -d /tmp/android-tools \
    && mkdir -p ${ANDROID_HOME}/cmdline-tools/latest \
    && mv /tmp/android-tools/cmdline-tools/* ${ANDROID_HOME}/cmdline-tools/latest/ \
    && yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
WORKDIR /src
COPY . .
ARG NODE_BOOTSTRAP_TOKEN
RUN gradle assembleRelease --no-daemon

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless python3 openssl ca-certificates bash && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/android-sdk/build-tools/35.0.0 /opt/android-build-tools
COPY --from=build /src/app/build/outputs/apk/release/app-release-unsigned.apk /opt/release/app-release-unsigned.apk
COPY release-entrypoint.sh release-server.py /opt/release/
ENV PATH=/opt/android-build-tools:${PATH}
ENV PORT=8080
ENV VERSION_CODE=171
ENV VERSION_NAME=1.7.1
ENV PACKAGE_NAME=com.pentagon.providernode
ENV RELEASE_NOTES="Pentagon Provider Node 1.7.1: zero-config SIM provider detection, automatic node provisioning, cloud credential bootstrap, TrustPositif probe, telemetry, and secure self-update."
EXPOSE 8080
CMD ["bash", "/opt/release/release-entrypoint.sh"]
