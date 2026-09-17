FROM node:20-alpine

# git: for workspace.ts's `git worktree` calls (Task 2).
# docker-cli: for its `docker run`/`exec`/`rm` calls — talks to the socket
# bind-mounted in via docker-compose.yml (Task 4), not a nested daemon.
RUN apk add --no-cache git docker-cli bash

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
