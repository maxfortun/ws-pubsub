# syntax=docker/dockerfile:1
FROM node:21-alpine3.18

COPY app/ /usr/src/app/

# Every dependency is public: no credentials needed to build
RUN cd /usr/src/app/ && npm i --no-audit --no-fund
