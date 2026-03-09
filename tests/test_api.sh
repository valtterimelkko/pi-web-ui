#!/bin/bash
set -e

# Kill any existing processes
pkill -f "tsx watch\|vite" 2>/dev/null || true
sleep 2

# Start server
cd /root/pi-web-ui/server
npm run dev &
SERVER_PID=$!

# Wait for server
sleep 8

echo "=== Testing API ==="

# Get cookies
curl -s -c /tmp/cookies.txt http://localhost:3001/health > /dev/null

echo "Cookies:"
cat /tmp/cookies.txt | grep -v "^#" | tail -5

echo ""
echo "=== Login test ==="
RESPONSE=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -b /tmp/cookies.txt \
  -d '{"password":"admin"}')

echo "Response: $RESPONSE"

# Cleanup
kill $SERVER_PID 2>/dev/null || true

echo ""
echo "=== Done ==="
