# Deployment Guide

> Production runbook for Pi Web UI. See [`README.md`](./README.md) for the concise operating overview and [`docs/PROCESS-ISOLATION-DESIGN.md`](./docs/PROCESS-ISOLATION-DESIGN.md) for the worker-isolation rationale behind these settings.

## Production Checklist

- [ ] Change default admin password
- [ ] Set strong JWT_SECRET and CSRF_SECRET
- [ ] Configure ALLOWED_ORIGINS correctly
- [ ] Enable HTTPS/WSS
- [ ] Set up proper logging
- [ ] Configure firewall rules
- [ ] Set up monitoring
- [ ] Configure worker process limits (see Worker Architecture below)

## Worker Architecture

Pi Web UI uses a worker pool architecture for handling AI agent tasks. Each worker runs in an isolated process with configurable memory limits.

### Memory Requirements

| Configuration | Memory Required | Description |
|--------------|-----------------|-------------|
| **Minimum** | 2GB | Server only, minimal agents |
| **Recommended** | 4GB | Server + 5-8 workers |
| **Production** | **6GB** | Server + 10-15 workers |

**Total memory calculation:**
- Base server: ~512MB
- Per worker: ~350-512MB (depends on model and task complexity)
- Example: 6GB supports server + ~10-12 concurrent workers

### Worker Process Configuration

Workers are configured via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_MAX_WORKERS` | 5 | Maximum concurrent workers |
| `PI_WORKER_MEMORY` | 512 | Memory per worker (MB) |
| `PI_IDLE_TIMEOUT` | 1800000 | Worker idle timeout (ms) - 30 minutes |

### systemd Service

Create `/etc/systemd/system/pi-web-ui.service`:

```ini
[Unit]
Description=Pi Web UI - Web Interface for Pi Coding Agent
After=network.target
Wants=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/opt/pi-web-ui
Environment=NODE_ENV=production
Environment=PORT=3456

# Worker configuration
Environment=PI_MAX_WORKERS=5
Environment=PI_WORKER_MEMORY=512
Environment=PI_IDLE_TIMEOUT=1800000

ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure
RestartSec=10

# Memory limits (adjust based on PI_MAX_WORKERS)
# 6GB total for production with 10-15 workers
MemoryMax=6G
MemoryHigh=5G

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable pi-web-ui
sudo systemctl start pi-web-ui
sudo systemctl status pi-web-ui
```

### Systemd Override for Worker Configuration

To customize worker settings without modifying the main service file, create an override:

```bash
sudo systemctl edit pi-web-ui
```

Add the following override configuration:

```ini
[Service]
# Increase memory limit for worker processes
# 6GB recommended for production with 10-15 workers
MemoryMax=6G
MemoryHigh=5G

# Environment for worker configuration
Environment="PI_MAX_WORKERS=15"
Environment="PI_WORKER_MEMORY=512"
Environment="PI_IDLE_TIMEOUT=1800000"
```

Apply changes:
```bash
sudo systemctl daemon-reload
sudo systemctl restart pi-web-ui
```

### Monitoring Worker Processes

Monitor worker status using systemd tools:

```bash
# View service status and memory usage
systemctl status pi-web-ui

# Monitor resource usage in real-time
systemctl status pi-web-ui -l --no-pager

# Check memory consumption
systemctl show pi-web-ui -p MemoryCurrent

# View worker process tree
ps auxf | grep pi-web-ui

# Check for OOM kills
journalctl -u pi-web-ui -n 100 | grep -i "oom\|killed"
```

Monitor via application logs:
```bash
# View logs
journalctl -u pi-web-ui -f

# Check for worker-related log entries
journalctl -u pi-web-ui | grep -i "worker\|spawn\|exit"
```

### Troubleshooting Worker Issues

#### Workers Not Starting

**Symptoms:** Tasks queue but no workers process them

**Diagnostic Steps:**
1. Check memory availability:
   ```bash
   free -h
   systemctl status pi-web-ui -p MemoryCurrent
   ```
2. Verify worker limits:
   ```bash
   systemctl show pi-web-ui --property=Environment
   ```
3. Check logs for spawn errors:
   ```bash
   journalctl -u pi-web-ui -n 50 | grep -i "spawn\|fork\|worker"
   ```

**Common Fixes:**
- Increase `MemoryMax` if OOM killed
- Reduce `PI_MAX_WORKERS` if memory constrained
- Check file descriptor limits: `ulimit -n`

#### Memory-Related Worker Crashes

**Symptoms:** Workers exit with code 137 (OOM) or memory errors

**Diagnostic Steps:**
1. Check for OOM kills:
   ```bash
   dmesg | grep -i "oom\|pi-web-ui"
   ```
2. Monitor memory over time:
   ```bash
   systemd-cgtop /system.slice/pi-web-ui.service
   ```

**Common Fixes:**
- Reduce `PI_WORKER_MEMORY` per worker
- Decrease `PI_MAX_WORKERS`
- Add swap space for burst capacity:
   ```bash
   sudo fallocate -l 2G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   ```

#### Worker Timeouts

**Symptoms:** Long-running tasks killed mid-execution

**Diagnostic Steps:**
1. Check for timeout errors in logs
2. Verify `PI_IDLE_TIMEOUT` setting

**Common Fixes:**
- Increase `PI_IDLE_TIMEOUT` for long-running tasks:
  ```bash
  # 1 hour timeout
  Environment="PI_IDLE_TIMEOUT=3600000"
  ```
- Implement task chunking for very long operations

#### High Worker Turnover

**Symptoms:** Workers constantly spawning and exiting

**Diagnostic Steps:**
1. Check worker exit codes:
   ```bash
   journalctl -u pi-web-ui | grep "worker.*exit"
   ```
2. Monitor spawn rate:
   ```bash
   journalctl -u pi-web-ui | grep -c "worker.*spawn"
   ```

**Common Fixes:**
- Increase `PI_IDLE_TIMEOUT` to keep workers warm
- Check for application errors causing crashes
- Verify memory limits aren't too restrictive

## Nginx Configuration

```nginx
server {
    listen 443 ssl http2;
    server_name pi.example.com;

    ssl_certificate /etc/letsencrypt/live/pi.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pi.example.com/privkey.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Static files
    location / {
        root /opt/pi-web-ui/client/dist;
        try_files $uri $uri/ /index.html;
    }

    # API
    location /api/ {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

## Docker Deployment

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3456

CMD ["node", "server/dist/index.js"]
```

**Docker Compose with Worker Configuration:**

```yaml
version: '3.8'
services:
  pi-web-ui:
    build: .
    ports:
      - "3456:3456"
    environment:
      - NODE_ENV=production
      - JWT_SECRET=${JWT_SECRET}
      - CSRF_SECRET=${CSRF_SECRET}
      # Worker configuration
      - PI_MAX_WORKERS=10
      - PI_WORKER_MEMORY=512
      - PI_IDLE_TIMEOUT=1800000
    deploy:
      resources:
        limits:
          memory: 6G
        reservations:
          memory: 2G
    restart: unless-stopped
```

## Environment Variables

| Variable | Production Value |
|----------|-----------------|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | Strong random string (32+ chars) |
| `CSRF_SECRET` | Strong random string (32+ chars) |
| `ALLOWED_ORIGINS` | Your domain only |
| `PORT` | `3456` (server port, defaults to `3001` if unset) |
| `PI_MAX_WORKERS` | `10` (adjust based on memory) |
| `PI_WORKER_MEMORY` | `512` (MB per worker) |
| `PI_IDLE_TIMEOUT` | `1800000` (30 minutes in ms) |
| `OPENCODE_SERVER_PORT` | `4096` (OpenCode headless server port) |
| `OPENCODE_SERVER_HOST` | `127.0.0.1` |
| `OPENCODE_SERVER_PASSWORD` | Optional basic auth password for OpenCode server |
| `OPENCODE_ENABLED` | `true` (set to `false` to disable OpenCode Direct) |
| `OPENCODE_WORKING_DIR` | Working directory for OpenCode server process |
