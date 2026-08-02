# Synced

Minimal, privacy-focused, real-time file sharing and chat. Share messages and large files without accounts or a database.

![Synced](https://github.com/user-attachments/assets/61e85c9c-5bd2-4884-943b-654ea82241a2)

## Features

- Real-time text messaging with a live user count.
- Drag and drop, file picker, and clipboard uploads.
- Resumable uploads for files up to 8 GiB by default.
- Image, video, audio, text, and PDF previews.
- Persistent file links with random IDs.
- Clean, sanitized filenames when downloading.
- No user accounts, chat history, or database.

## Quick start

### Requirements

- Docker Engine
- Docker Compose v2

### 1. Clone the repository

```bash
git clone https://github.com/ThomasBaruzier/synced.git
cd synced
```

### 2. Create the configuration

```bash
cp .env.example .env
```

The defaults are suitable for local use.

### 3. Create the upload directory

```bash
mkdir -p uploads
```

On Linux, the container runs as UID `1000`. If uploads fail because of permissions:

```bash
sudo chown -R 1000:1000 uploads
chmod 750 uploads
```

### 4. Start Synced

```bash
docker compose up -d --build
```

Open:

```text
http://localhost:3000
```

View logs:

```bash
docker compose logs -f app
```

Stop Synced:

```bash
docker compose down
```

Uploaded files remain in `./uploads`.

## How file sharing works

Files are uploaded sequentially in 64 MiB chunks by default. Each request remains small enough to work through common reverse proxies and Cloudflare's 100 MB request limit.

If an upload is interrupted:

1. Reopen Synced.
2. Select the same file again.
3. Synced continues from the last saved byte offset.

Resume state expires after 24 hours by default. The browser must ask you to select the file again because websites cannot reopen arbitrary local files automatically.

Completed files use URLs such as:

```text
/uploads/4f89c30f1cfa45fda94d88ebcd5284c1-example.pdf
```

The random ID prevents collisions and makes links difficult to guess. The readable filename remains visible in the URL.

Downloads use a separate endpoint so the saved file is named:

```text
example.pdf
```

Anyone with a file link can access it. Synced does not provide accounts, per-file passwords, or access control.

## Configuration

Edit `.env`, then recreate the container:

```bash
docker compose up -d --build
```

| Variable | Default | Description |
| --- | ---: | --- |
| `HOST` | `127.0.0.1` | Address published by Docker or used by Node. |
| `PORT` | `3000` | Published application port. |
| `PUBLIC_SERVE` | `true` | Let Node serve the interface and uploaded files. |
| `MAX_UPLOAD_MB` | `8192` | Maximum size of one file in MiB. |
| `UPLOAD_CHUNK_MB` | `64` | Size of each upload request in MiB. |
| `UPLOAD_SESSION_TTL_HOURS` | `24` | Lifetime of inactive resumable upload state. |
| `UPLOAD_INIT_PER_MIN_PER_IP` | `20` | New upload sessions allowed per IP each minute. |
| `UPLOAD_CHUNKS_PER_MIN_PER_IP` | `300` | Upload requests allowed per IP each minute. |
| `MAX_ACTIVE_UPLOADS_PER_IP` | `5` | Maximum incomplete uploads associated with one IP. |
| `MAX_USERS` | `100` | Maximum simultaneous Socket.IO connections. |
| `MAX_REQ_PER_MIN_PER_IP` | `100` | Chat messages allowed per IP each minute. |
| `DISK_RESERVED_MB` | `1024` | Disk space kept in reserve. |
| `TRUST_PROXY` | `loopback` | Proxy addresses or ranges trusted by Express. |

If `UPLOAD_CHUNK_MB` is changed, every proxy and CDN request limit must remain larger than one chunk. The proxy limit does not need to be larger than the complete file.

## Production deployment with Nginx

This section is optional. The Docker quick start is enough for local use.

A production setup can let Nginx serve the interface and completed files while Node handles uploads, downloads, and Socket.IO.

### 1. Configure Synced

Set these values in `.env`:

```env
HOST=127.0.0.1
PORT=3000
PUBLIC_SERVE=false
TRUST_PROXY=loopback,linklocal,uniquelocal
```

Start Synced:

```bash
docker compose up -d --build
```

Use absolute paths for the repository in the Nginx configuration. The example below assumes:

```text
/srv/synced/public
/srv/synced/uploads
```

The container must be able to write to `uploads`, and the Nginx user must be able to read `public` and completed uploads.

### 2. Configure Nginx

Place the `map` in Nginx's `http` context. Depending on the distribution, a site file included from the `http` context may also contain it.

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name share.example.com;

    root /srv/synced/public;
    index index.html;

    access_log off;

    location = /uploads/.partial {
        return 404;
    }

    location ^~ /uploads/.partial/ {
        return 404;
    }

    location ^~ /uploads/ {
        alias /srv/synced/uploads/;

        add_header X-Content-Type-Options "nosniff" always;
        add_header Content-Security-Policy "default-src 'none'; sandbox allow-popups" always;
        add_header Content-Disposition "inline" always;
    }

    location = /upload {
        client_max_body_size 70m;

        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_connect_timeout 60s;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /download/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 3600s;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ @node;
    }

    location @node {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_buffering off;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Add TLS using your preferred certificate setup, then validate Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Confirm temporary upload state is blocked:

```bash
curl -I https://share.example.com/uploads/.partial
curl -I https://share.example.com/uploads/.partial/
```

Both requests should return `404`.

When using Cloudflare, restrict direct access to the origin and restore visitor IPs only from trusted Cloudflare address ranges. Do not expose the Node port publicly or trust forwarding headers from arbitrary clients.

## Manual installation

Node.js 22 or later is required.

```bash
git clone https://github.com/ThomasBaruzier/synced.git
cd synced
cp .env.example .env
npm ci --omit=dev
mkdir -p uploads
npm start
```

Open `http://localhost:3000`.

The operating system user running Node must be able to write to `uploads`.

## Updating

```bash
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 app
```

## Privacy

Synced does not persist:

- Chat history.
- User accounts.
- Raw IP addresses.
- Routine server-side activity logs.

For rate limiting, IP-derived identifiers are salted, hashed, and kept only in process memory. They change when the server restarts.

Synced does persist:

- Completed uploaded files.
- Temporary resumable upload state.
- Sanitized filenames in public URLs.

The browser temporarily stores a hashed file fingerprint, upload ID, and timestamp so interrupted uploads can resume. Recent warnings and errors remain in browser memory unless the user copies them with the diagnostic button.

Reverse proxies and CDN providers may keep their own logs or analytics independently of Synced.

## Troubleshooting

### Uploads fail immediately

Check that the container can write to the upload directory:

```bash
docker compose exec app test -w /app/uploads
```

### Large uploads fail at the same offset

Check these values:

- CDN request body limit
- Nginx `client_max_body_size`
- `UPLOAD_CHUNK_MB`

The proxy limit must be larger than one chunk.

### An upload does not resume

Confirm that:

- The same file was selected.
- Its name, size, and modification time did not change.
- The session has not expired.
- Browser storage was not cleared.
- The matching state still exists in `uploads/.partial`.

### Live chat does not connect

Check Socket.IO and the application logs:

```bash
curl -I http://127.0.0.1:3000/socket.io/socket.io.js
docker compose logs --tail=100 app
```

If using a reverse proxy, verify its WebSocket headers and `TRUST_PROXY` setting.

## License

[Apache License 2.0](LICENSE).

Font Awesome assets are covered by [their bundled license](public/assets/fontawesome-LICENSE.txt).
