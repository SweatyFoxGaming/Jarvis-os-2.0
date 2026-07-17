# Use official Node.js 20 lightweight Alpine image
FROM node:20-alpine

# Set working directory inside the container
WORKDIR /app

# Copy dependency manifests first to leverage Docker layer caching
COPY package*.json ./

# Install packages (including devDependencies like tsx for executing TypeScript directly)
RUN npm install

# Copy the rest of the application files
COPY . .

# Expose port 3000 (the only externally accessible port routed by reverse proxy)
EXPOSE 3000

# Default command starts the application using tsx
CMD ["npm", "run", "start"]
