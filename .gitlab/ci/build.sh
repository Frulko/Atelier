#!/bin/sh
set -eu

TAGS="$IMAGE:$ATELIER_RELEASE"
VERSION="$ATELIER_RELEASE"
if [ -n "${CI_COMMIT_TAG:-}" ]; then
  VERSION="${CI_COMMIT_TAG#v}"
  TAGS="$TAGS,$IMAGE:$VERSION"
elif [ "${CI_COMMIT_BRANCH:-}" = "$CI_DEFAULT_BRANCH" ]; then
  TAGS="$TAGS,$IMAGE:latest"
else
  TAGS="$TAGS,$IMAGE:staging"
fi

$BUILDCTL build \
  --frontend dockerfile.v0 \
  --local "context=$BUILD_CONTEXT" \
  --local "dockerfile=$DOCKERFILE_DIR" \
  --opt filename=Dockerfile \
  --opt "platform=$PLATFORMS" \
  --opt "build-arg:ATELIER_VERSION=$VERSION" \
  --opt "build-arg:ATELIER_SOURCE=$CI_PROJECT_URL" \
  --output "type=image,\"name=$TAGS\",push=true"
