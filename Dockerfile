# Use official Node.js 20 lightweight Alpine image
FROM node:20-alpine

# Install Python 3, pip, and bash for scripting
RUN apk add --no-cache python3 py3-pip bash

# Set working directory inside the container
WORKDIR /app

# Copy dependency manifests first to leverage Docker layer caching
COPY package*.json ./

# Install packages (including devDependencies like tsx for executing TypeScript directly)
RUN npm install

# Copy requirements file first for caching
COPY requirements.txt ./

# Install python dependencies
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages || pip3 install --no-cache-dir -r requirements.txt

# Copy the rest of the application files
COPY . .

# Expose port 8000 (FastAPI gateway) and 3000 (Express API)
EXPOSE 8000 3000

# Default command starts the FastAPI Gateway, which spawns the Node.js Express server on startup
CMD ["python3", "-m", "uvicorn", "src.api:app", "--host", "0.0.0.0", "--port", "8000"]
