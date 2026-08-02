# Synced

Minimal, privacy-first, real-time file sharing and chat platform built with Node.js and Socket.io. It enables instant sharing and media previews without the need for a database.

![synced](https://github.com/user-attachments/assets/61e85c9c-5bd2-4884-943b-654ea82241a2)

## Features

### Communication
- Real-time text messaging broadcast via WebSockets.
- Dynamic user color assignment based on active session hues.
- Live counter showing the number of connected users.
- Automatic message grouping by sender and timestamp.

### File Sharing
- Instant drag and drop file uploads from the desktop.
- Paste support to upload files directly from the clipboard.
- Resumable upload queue management with a global progress bar.
- Support for large file transfers up to 8GB by default.
- Persistent file access via the uploads directory.
- ID-prefixed links with clean sanitized filenames on download.

### Media and UI
- Integrated preview engine for images, videos, and audio.
- Built-in PDF viewer with mobile-specific fallback links.
- Resizable split-pane layout for simultaneous chat and previewing.
- Fullscreen video support with automatic orientation locking.
- Audio player with seek, progress tracking, and instance management.

### Security and Maintenance
- IP-based rate limiting to prevent message and upload spam.
- Disk space monitoring to halt uploads when host storage is low.
- Ephemeral IP anonymization using SHA-256 and a random startup salt.
- No chat history or routine server-side IP or activity logs are persisted.
- Client-side error log manager for troubleshooting.
- Configurable proxy trust settings for secure production headers.

## Technical details

- Framework: Built on Node.js 22 using Express 5 and Socket.io 4.
- Database: None. File metadata is derived directly from the filesystem.
- MIME Detection: Uses the file-type library to inspect magic bytes for security.
- Storage: Files use random ID-prefixed, sanitized names to prevent collisions.
- Networking: Streams files in resumable chunks below common reverse-proxy request limits.
- Privacy: IP-derived abuse-prevention keys exist only in memory and change after each server restart.

## Configuration

Settings are managed via the `.env` file.

| Variable | Default | Description |
| --- | --- | --- |
| PORT | 3000 | Port where the application listens. |
| HOST | 127.0.0.1 | Host address to bind the server to. |
| MAX_UPLOAD_MB | 8192 | Maximum allowed size per file in megabytes. |
| UPLOAD_CHUNK_MB | 64 | Upload chunk size in megabytes. |
| UPLOAD_SESSION_TTL_HOURS | 24 | Inactive resumable session lifetime. |
| UPLOAD_INIT_PER_MIN_PER_IP | 20 | Upload sessions allowed per minute per IP. |
| UPLOAD_CHUNKS_PER_MIN_PER_IP | 300 | Upload status and chunk requests allowed per minute per IP. |
| MAX_ACTIVE_UPLOADS_PER_IP | 5 | Maximum incomplete uploads per IP. |
| MAX_USERS | 100 | Maximum number of concurrent socket connections. |
| MAX_REQ_PER_MIN_PER_IP | 100 | Rate limit for socket messages per minute per IP. |
| PUBLIC_SERVE | true | If true, Node serves static files and uploads. |
| DISK_RESERVED_MB | 1024 | Minimum free disk space required for uploads. |
| TRUST_PROXY | loopback | List of proxy addresses to trust. |

## Quick start

The recommended way to run Synced is via Docker.

1. Clone the repository.
2. Create your environment file:
```bash
cp .env.example .env
```
3. Create the storage directory:
```bash
mkdir -p uploads
sudo chown 1000:1000 uploads
chmod 750 uploads
```
4. Start the container:
```bash
docker-compose up -d
```
5. Access the application at `http://localhost:3000`.

## Manual installation

Ensure Node.js 22 or later is installed.

1. Install dependencies:
```bash
npm ci --omit=dev
```
2. Create the upload directory:
```bash
mkdir uploads
```
3. Start the server:
```bash
npm start
```

## Production deployment

For high-performance environments, use Nginx to serve static assets and the uploads directory.

1. Set `PUBLIC_SERVE=false` in your `.env`.
2. Configure Nginx:

```nginx
server {
    server_name share.example.com;
    listen 80;
    access_log off;

    root /var/www/synced/public;
    index index.html;

    location ^~ /uploads/.partial/ {
        return 404;
    }

    location /uploads/ {
        alias /var/www/synced/uploads/;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Content-Security-Policy "default-src 'none'; sandbox allow-popups" always;
        add_header Content-Disposition "inline" always;
    }

    location = /upload {
        client_max_body_size 70m;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        try_files $uri $uri/ @node;
    }

    location @node {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_buffering off;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

The default 64MB chunks remain below Cloudflare's 100MB per-request limit. If `UPLOAD_CHUNK_MB` is changed, keep `client_max_body_size` above the configured chunk size and below any upstream request limit.
