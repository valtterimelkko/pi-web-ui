#!/bin/bash
# E2E test script using with_server.py approach

set -e

echo "========================================"
echo "Pi Web UI - End-to-End Test Script"
echo "========================================"
echo ""

# Check if with_server.py exists, if not, download it
if [ ! -f "scripts/with_server.py" ]; then
    echo "Downloading with_server.py helper..."
    curl -L -o scripts/with_server.py https://raw.githubusercontent.com/microsoft/playwright/main/scripts/with_server.py
    chmod +x scripts/with_server.py
fi

# Check for test argument
if [ "$1" == "--manual" ]; then
    echo "Starting servers for manual testing..."
    echo "Server will be available at:"
    echo "  - Frontend: http://localhost:5173"
    echo "  - Backend:  http://localhost:3000"
    echo ""
    echo "Press Ctrl+C to stop servers"
    echo ""
    
    # Run servers without running tests
    python3 scripts/with_server.py \
        --server "cd server && npm run dev" --port 3000 \
        --server "cd client && npm run dev" --port 5173 \
        --wait 5 \
        -- sh -c "echo 'Servers are running. Press Ctrl+C to stop.' && while true; do sleep 1; done"
else
    echo "Starting E2E tests..."
    echo ""
    
    # Check if e2e test file exists
    if [ -f "tests/e2e/basic.spec.ts" ]; then
        echo "Running Playwright E2E tests..."
        python3 scripts/with_server.py \
            --server "cd server && npm run dev" --port 3000 \
            --server "cd client && npm run dev" --port 5173 \
            --wait 5 \
            -- npx playwright test tests/e2e/
    else
        echo "No E2E tests found. Running servers for verification..."
        python3 scripts/with_server.py \
            --server "cd server && npm run dev" --port 3000 \
            --server "cd client && npm run dev" --port 5173 \
            --wait 5 \
            -- echo "✓ Servers started successfully"
    fi
    
    echo ""
    echo "========================================"
    echo "E2E test complete!"
    echo "========================================"
fi
