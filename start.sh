#!/bin/bash

# Recover — start all services locally

echo "Starting Recover platform..."

# 1. Next.js backend on :3001
echo "[1/4] Starting Next.js backend (port 3001)..."
npm run dev &
NEXT_PID=$!

# 2. Python video service on :8000
echo "[2/4] Starting Python video service (port 8000)..."
cd video-service && ./venv/bin/uvicorn main:app --reload --port 8000 &
VIDEO_PID=$!
cd ..

# 3. Frontend Vite on :5173
echo "[3/4] Starting frontend (port 5173)..."
cd /tmp/recover-frontend && npm run dev &
FRONTEND_PID=$!
cd /Users/aishwarya/recover

# 4. ngrok tunnel on :3001 (serves both Resend webhooks + HLS for NomadicML)
echo "[4/4] Starting ngrok on port 3001..."
pkill -f "ngrok http 3001" 2>/dev/null
ngrok http 3001 --log=stdout > /tmp/ngrok.log 2>&1 &
NGROK_PID=$!

# Wait for ngrok to get a URL
echo "    Waiting for ngrok tunnel..."
NGROK_URL=""
for i in {1..15}; do
  sleep 1
  NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
    | python3 -c "import sys,json; tunnels=json.load(sys.stdin).get('tunnels',[]); t=[t for t in tunnels if 'https' in t.get('public_url','')]; print(t[0]['public_url'] if t else '')" 2>/dev/null)
  [ -n "$NGROK_URL" ] && break
done

if [ -n "$NGROK_URL" ]; then
  # Update video-service/.env with fresh ngrok URL
  if grep -q "PUBLIC_VIDEO_SERVICE_URL" video-service/.env; then
    sed -i '' "s|PUBLIC_VIDEO_SERVICE_URL=.*|PUBLIC_VIDEO_SERVICE_URL=$NGROK_URL|" video-service/.env
  else
    echo "PUBLIC_VIDEO_SERVICE_URL=$NGROK_URL" >> video-service/.env
  fi
  echo ""
  echo "  ngrok URL: $NGROK_URL"
  echo "  → Set this as your Resend webhook base URL"
  echo "  → HLS for NomadicML live analysis: $NGROK_URL/hls/<stream_id>/index.m3u8"
else
  echo "  ⚠ Could not get ngrok URL — live analysis may not work."
  echo "    Run: ngrok http 3001  and update video-service/.env manually."
fi

echo ""
echo "All services started:"
echo "  Backend:       http://localhost:3001"
echo "  Video service: http://localhost:8000"
echo "  Frontend:      http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop all."

trap "kill $NEXT_PID $VIDEO_PID $FRONTEND_PID $NGROK_PID 2>/dev/null; exit" INT
wait
