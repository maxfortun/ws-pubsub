# syntax=docker/dockerfile:1
FROM node:21-alpine3.18

COPY app/ /usr/src/app/

ARG GIT_CREDENTIALS

RUN <<_EOT_
	set -e +x
	echo "$GIT_CREDENTIALS" | base64 -d > $HOME/.git-credentials
	apk add git
	git config --global credential.helper store
	cd /usr/src/app/
	npm i
	rm $HOME/.git-credentials
_EOT_
