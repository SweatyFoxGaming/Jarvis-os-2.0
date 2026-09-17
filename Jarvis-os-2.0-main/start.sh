#!/bin/bash
cd /mnt/jarvis_home/llm
docker compose up -d
echo "Jarvis is starting..."
sleep 3
docker compose ps
# Open browser (try multiple methods)
if command -v google-chrome &> /dev/null; then
    google-chrome http://localhost:8000 &
elif command -v firefox &> /dev/null; then
    firefox http://localhost:8000 &
else
    xdg-open http://localhost:8000 &
fi
# Keep terminal open for debugging (remove this line once it's working)
read -p "Press Enter to close..."
