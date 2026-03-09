# Deployment Guide

## Production Checklist

- [ ] Change default admin password
- [ ] Set strong JWT_SECRET and CSRF_SECRET
- [ ] Configure ALLOWED_ORIGINS correctly
- [ ] Enable HTTPS/WSS
- [ ] Set up proper logging
- [ ] Configure firewall rules
- [ ] Set up monitoring

## systemd Service

Create `/etc/systemd/system/pi-web-ui.service`:

```ini
[Unit]
Description=Pi Web UI Server
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/opt/pi-web-ui
ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
Environment=PI_WEB_UI_PORT=3000

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable pi-web-ui
sudo systemctl start pi-web-ui
sudo systemctl status pi-web-ui
```

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
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:3000;
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

EXPOSE 3000

CMD ["node", "server/dist/index.js"]
```

## Environment Variables

| Variable | Production Value |
|----------|-----------------|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | Strong random string (32+ chars) |
| `CSRF_SECRET` | Strong random string (32+ chars) |
| `ALLOWED_ORIGINS` | Your domain only |
| `PI_WEB_UI_PORT` | `3000` (or as needed) |
