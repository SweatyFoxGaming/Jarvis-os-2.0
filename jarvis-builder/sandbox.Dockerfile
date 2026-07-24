FROM node:20-alpine

RUN apk add --no-cache git bash

WORKDIR /workspace
