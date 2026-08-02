"use strict";

const LogManager = {
  buffer: [],
  limit: 200,

  copy() {
    if (!this.buffer.length) return 'No diagnostics recorded.';
    return this.buffer.join('\n');
  },

  init() {
    const format = value => {
      try {
        if (value instanceof Error) {
          return `${value.name}: ${value.message}`;
        }
        if (typeof value === 'object' && value !== null) {
          return JSON.stringify(value);
        }
        return String(value);
      } catch {
        return String(value);
      }
    };

    const push = (level, args) => {
      const message = args.map(format).join(' ');
      const time = new Date().toLocaleTimeString();
      this.buffer.push(`[${level}] ${time}: ${message}`);
      if (this.buffer.length > this.limit) this.buffer.shift();
    };

    const originalWarn = console.warn;
    const originalError = console.error;

    console.warn = (...args) => {
      push('WRN', args);
      originalWarn.apply(console, args);
    };

    console.error = (...args) => {
      push('ERR', args);
      originalError.apply(console, args);
    };

    window.addEventListener('error', event => {
      push('ERR', [
        `Global error: ${event.message}`,
        event.filename,
        event.lineno
      ]);
    });

    window.addEventListener('unhandledrejection', event => {
      push('ERR', ['Unhandled Promise Rejection', event.reason]);
    });
  }
};

LogManager.init();

const socket = io();

socket.on('connect_error', error => {
  console.error('Socket connection failed:', error);
});

let myHue = 210;
const TLD_SET = new Set();
let tldsLoaded = false;

fetch('/tlds.txt')
  .then(res => {
    if (res.ok) return res.text();
    throw new Error(`TLD fetch failed: ${res.status}`);
  })
  .then(text => {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#') ||
        line.startsWith('XN--')) continue;
      TLD_SET.add(line.toUpperCase());
    }
    tldsLoaded = true;
  })
  .catch(error => {
    console.error('TLD list failed to load:', error);
  });

const ANIM_CONFIG = {
  GRAVITY_BIAS: -0.4,
  PARTICLE_COUNT: 35,
  SPREAD_MULTIPLIER: 350,
  STAGGER_DELAY_MS: 35
};

const CONFIG = {
  COPY_LIMIT_SIZE: 50 * 1024 * 1024,
  MOBILE_BREAKPOINT: 900,
  RESUME_STORAGE_TTL: 24 * 60 * 60 * 1000,
  TEXT_PREVIEW_LIMIT: 2 * 1024 * 1024
};

const Toast = {
  el: null,
  tm: null,

  show(msg, type = 'info') {
    if (this.el) {
      this.el.remove();
      clearTimeout(this.tm);
    }

    const pane = document.querySelector('.chat-pane');
    if (!pane) return;

    const div = document.createElement('div');
    div.className = `chat-notification ${type}`;
    div.textContent = msg;

    pane.appendChild(div);
    this.el = div;

    const DURATION_IN = 500;
    const DURATION_STAY = 2000;

    this.tm = setTimeout(() => {
      if (this.el) {
        this.el.classList.add('closing');
        this.el.addEventListener('animationend', () => {
          if (this.el) {
            this.el.remove();
            this.el = null;
          }
        }, { once: true });
      }
    }, DURATION_IN + DURATION_STAY);
  }
};

const UI = {
  actionBtns: [
    document.getElementById('copy-link-btn'),
    document.getElementById('download-btn'),
    document.getElementById('modal-copy-link-btn'),
    document.getElementById('modal-download-btn')
  ],
  copyContentBtns: [
    document.getElementById('copy-content-btn'),
    document.getElementById('modal-copy-content-btn')
  ],
  debugBtn: document.getElementById('debug-btn'),
  dropOverlay: document.getElementById('drop-overlay'),
  fileBtn: document.getElementById('file-btn'),
  fileInput: document.getElementById('file-input'),
  input: document.getElementById('input-text'),
  loader: document.getElementById('loader-bar'),
  messageList: document.getElementById('message-list'),
  modal: document.getElementById('modal-viewer'),
  modalCloseBtn: document.getElementById('modal-close-btn'),
  modalContent: document.getElementById('modal-content'),
  previewPane: document.getElementById('preview-pane'),
  previewStage: document.getElementById('preview-stage'),
  resetBtn: document.getElementById('reset-btn'),
  resizer: document.getElementById('drag-handle'),
  sendBtn: document.getElementById('send-btn'),
  userCount: document.getElementById('user-count')
};

if (UI.debugBtn) {
  UI.debugBtn.onclick = () => {
    const logs = LogManager.copy();
    navigator.clipboard.writeText(logs)
      .then(() => {
        Toast.show('Logs copied to clipboard');
      })
      .catch(error => {
        Toast.show('Failed to copy logs', 'error');
        console.error('Diagnostic copy failed:', error);
      });
  };
}

const Utils = {
  formatSize(bytes) {
    if (!bytes) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const val = bytes / Math.pow(1024, i);
    return `${val.toFixed(1)} ${sizes[i]}`;
  },

  formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    });
  },

  getIcon(mime) {
    if (!mime) return 'fa-file-alt';
    if (mime.startsWith('image')) return 'fa-file-image';
    if (mime.startsWith('video')) return 'fa-file-video';
    if (mime.startsWith('audio')) return 'fa-file-audio';
    if (mime.includes('pdf')) return 'fa-file-pdf';
    if (mime.match(/zip|compressed|tar/)) {
      return 'fa-file-archive';
    }
    if (mime.match(/text|json|script|xml/)) {
      return 'fa-file-code';
    }
    return 'fa-file-alt';
  },

  isValidTLD(hostname) {
    if (!hostname) return false;
    const lastDot = hostname.lastIndexOf('.');
    if (lastDot < 1 || lastDot === hostname.length - 1) {
      return false;
    }
    const tld = hostname.slice(lastDot + 1);
    if (tldsLoaded) return TLD_SET.has(tld.toUpperCase());
    return /^[a-z]{2,}$/i.test(tld);
  },

  isWebSafe(mime) {
    const safe = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'image/svg+xml', 'image/avif', 'video/mp4', 'video/webm'
    ];
    return safe.includes(mime);
  },

  linkify(text) {
    const frag = document.createDocumentFragment();
    const parts = text.split(/(\s+)/);

    for (const part of parts) {
      if (!part || /^\s+$/.test(part)) {
        frag.append(part);
        continue;
      }

      const m = part.match(/^([(\[{<"']*)(.+?)([.,;!?)\]}>"']*)$/);
      if (!m) {
        frag.append(part);
        continue;
      }

      const [, pre, core, suf] = m;
      const lower = core.toLowerCase();
      let href = null;
      let host = lower;

      if (lower.startsWith('http://') ||
        lower.startsWith('https://')) {
        const protoEnd = lower.indexOf('://');
        host = lower.slice(protoEnd + 3);
        href = core;
      } else if (lower.startsWith('www.')) {
        href = 'http://' + core;
      } else if (lower.includes('@') &&
        !lower.startsWith('@') && !lower.endsWith('@')) {
        const at = lower.lastIndexOf('@');
        host = lower.slice(at + 1);
        if (this.isValidTLD(host)) {
          href = 'mailto:' + core;
          host = '';
        } else {
          href = null;
        }
      } else if (lower.includes('.')) {
        href = 'http://' + core;
      } else {
        host = '';
      }

      if (host) {
        const at = host.indexOf('@');
        if (at !== -1) {
          const slash = host.indexOf('/');
          if (slash === -1 || at < slash) {
            host = host.slice(at + 1);
          }
        }

        const pathStart = host.search(/[/?#:]/);
        if (pathStart !== -1) host = host.slice(0, pathStart);

        if (!this.isValidTLD(host)) href = null;
      }

      if (href) {
        if (pre) frag.append(pre);
        const a = document.createElement('a');
        a.href = href;
        a.textContent = core;
        a.rel = 'noopener noreferrer';
        a.target = '_blank';
        frag.append(a);
        if (suf) frag.append(suf);
      } else {
        frag.append(part);
      }
    }
    return frag;
  },

  nextFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
  },

  triggerDownload(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.target = '_blank';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
  }
};

const Animation = {
  async clearChat() {
    const chatPane = UI.messageList.parentElement;
    const bubbles = Array.from(UI.messageList.querySelectorAll('.bubble'));

    const containerRect = chatPane.getBoundingClientRect();
    const visibleItems = [];

    for (const bubble of bubbles) {
      const el = bubble.firstElementChild;
      if (!el) continue;
      const rect = el.getBoundingClientRect();

      const isVisible = rect.top < containerRect.bottom &&
        rect.bottom > containerRect.top;

      if (isVisible) {
        const style = window.getComputedStyle(el);
        let color = el.classList.contains('bubble-embed-container')
          ? style.borderTopColor
          : style.backgroundColor;

        if (!color || color === 'rgba(0, 0, 0, 0)' ||
          color === 'transparent') {
          color = '#2c2c2e';
        }

        visibleItems.push({
          element: el,
          bubble,
          rect,
          color
        });
      } else {
        bubble.style.visibility = 'hidden';
      }
    }

    if (!visibleItems.length) return;

    visibleItems.reverse();
    const promises = [];

    await Utils.nextFrame();

    for (const [i, item] of visibleItems.entries()) {
      const promise = new Promise(resolve => {
        setTimeout(() => {
          item.bubble.style.visibility = 'hidden';
          this.explodeRect(item.rect, item.color, chatPane).then(resolve);
        }, i * ANIM_CONFIG.STAGGER_DELAY_MS);
      });
      promises.push(promise);
    }

    await Promise.all(promises);
  },

  explodeRect(rect, color, container) {
    return new Promise(resolve => {
      const contRect = container.getBoundingClientRect();

      const pCont = document.createElement('div');
      pCont.style.position = 'absolute';
      pCont.style.left = `${rect.left - contRect.left}px`;
      pCont.style.top = `${rect.top - contRect.top}px`;
      pCont.style.width = `${rect.width}px`;
      pCont.style.height = `${rect.height}px`;
      pCont.style.pointerEvents = 'none';
      pCont.style.zIndex = '50';
      container.appendChild(pCont);

      const anims = [];

      for (let i = 0; i < ANIM_CONFIG.PARTICLE_COUNT; i++) {
        const p = document.createElement('div');
        p.style.position = 'absolute';
        const size = Math.random() * 5 + 2;
        p.style.width = `${size}px`;
        p.style.height = `${size}px`;
        p.style.backgroundColor = color;
        p.style.borderRadius = '50%';
        p.style.left = `${Math.random() * 100}%`;
        p.style.top = `${Math.random() * 100}%`;
        pCont.appendChild(p);

        const tx = (Math.random() - 0.5) *
          ANIM_CONFIG.SPREAD_MULTIPLIER;
        const ty = (Math.random() + ANIM_CONFIG.GRAVITY_BIAS) *
          ANIM_CONFIG.SPREAD_MULTIPLIER;

        const animation = p.animate([
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
          {
            transform: `translate(${tx}px, ${ty}px) scale(0)`,
            opacity: 0
          }
        ], {
          duration: 500 + Math.random() * 400,
          easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)',
          fill: 'forwards'
        });
        anims.push(animation.finished);
      }

      Promise.all(anims).then(() => {
        if (pCont.parentNode) container.removeChild(pCont);
        resolve();
      });
    });
  }
};

const AudioFactory = {
  current: null,

  create(url, name) {
    const el = document.createElement('div');
    el.className = 'audio-player';
    el.innerHTML = `
      <button class="audio-control-btn" aria-label="Play">
        <i class="fas fa-play"></i>
      </button>
      <div class="audio-info">
        <div class="audio-header">
          <span class="audio-name"></span>
          <span class="audio-time">0:00 / 0:00</span>
        </div>
        <div class="audio-slider-wrapper">
          <div class="audio-track-bg"></div>
          <div class="audio-progress-fill"></div>
          <input type="range" class="audio-slider" min="0" max="100"
            value="0" step="0.1">
        </div>
      </div>
      <audio preload="metadata"></audio>
    `;

    const audio = el.querySelector('audio');
    audio.src = url;

    const nameEl = el.querySelector('.audio-name');
    nameEl.textContent = name;
    nameEl.title = name;

    const btn = el.querySelector('.audio-control-btn');
    const icon = btn.querySelector('i');
    const timeDisplay = el.querySelector('.audio-time');
    const slider = el.querySelector('.audio-slider');
    const fill = el.querySelector('.audio-progress-fill');

    let isDragging = false;
    let duration = 0;

    const format = sec => {
      if (!sec || isNaN(sec)) return '0:00';
      const minutes = Math.floor(sec / 60);
      const seconds = Math.floor(sec % 60);
      return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

    const updateProgress = () => {
      if (isDragging) return;
      const current = audio.currentTime;
      const percent = (current / duration) * 100 || 0;
      slider.value = percent;
      fill.style.width = `${percent}%`;
      timeDisplay.textContent =
        `${format(current)} / ${format(duration)}`;
    };

    const toggle = () => {
      if (audio.paused) {
        if (AudioFactory.current &&
          AudioFactory.current !== audio) {
          AudioFactory.current.pause();
        }
        AudioFactory.current = audio;
        audio.play().catch(error => {
          console.error('Audio playback failed:', error);
        });
      } else {
        audio.pause();
      }
    };

    btn.onclick = event => {
      event.stopPropagation();
      toggle();
    };

    slider.onclick = event => event.stopPropagation();

    slider.oninput = () => {
      isDragging = true;
      const percent = slider.value;
      fill.style.width = `${percent}%`;
      const time = (percent / 100) * duration;
      timeDisplay.textContent =
        `${format(time)} / ${format(duration)}`;
    };

    slider.onchange = () => {
      isDragging = false;
      audio.currentTime = (slider.value / 100) * duration;
    };

    audio.onloadedmetadata = () => {
      duration = audio.duration;
      timeDisplay.textContent = `0:00 / ${format(duration)}`;
    };

    audio.ontimeupdate = updateProgress;

    audio.onplay = () => {
      icon.className = 'fas fa-pause';
      el.classList.add('playing');
    };

    audio.onpause = () => {
      icon.className = 'fas fa-play';
      el.classList.remove('playing');
    };

    audio.onended = () => {
      icon.className = 'fas fa-play';
      slider.value = 0;
      fill.style.width = '0%';
      timeDisplay.textContent = `0:00 / ${format(duration)}`;
      el.classList.remove('playing');
    };

    audio.onerror = event => {
      console.error('Audio element failed:', event.target.error);
    };

    return el;
  }
};

const TouchDelegate = {
  blockClick: false,
  elem: null,
  startX: 0,
  startY: 0,
  timer: null,

  init() {
    const list = UI.messageList;
    if (!list) return;

    list.addEventListener('touchstart', this.onStart.bind(this),
      { passive: true });
    list.addEventListener('touchmove', this.onMove.bind(this),
      { passive: true });
    list.addEventListener('touchend', this.onEnd.bind(this));
    list.addEventListener('touchcancel', this.onEnd.bind(this));
    list.addEventListener('click', this.onClick.bind(this), true);
    list.addEventListener('contextmenu', event => {
      if (event.target.closest(
        '.file-card, .bubble-embed-container, .audio-player')) {
        event.preventDefault();
      }
    });
  },

  onClick(event) {
    if (this.blockClick) {
      event.stopImmediatePropagation();
      event.preventDefault();
      this.blockClick = false;
      return;
    }

    if (window.matchMedia('(hover: none)').matches) {
      const isLink = event.target.closest('a');
      if (isLink) return;

      const bubble = event.target.closest('.bubble');
      const isAction = event.target.closest('.bubble-actions');

      if (!isAction) {
        document.querySelectorAll('.bubble.show-actions').forEach(item => {
          if (item !== bubble) item.classList.remove('show-actions');
        });
        document.querySelectorAll(
          '.message-group.show-timestamp'
        ).forEach(group => {
          if (!bubble || group !== bubble.closest('.message-group')) {
            group.classList.remove('show-timestamp');
          }
        });

        if (bubble && bubble.querySelector('.bubble-actions')) {
          bubble.classList.toggle('show-actions');
          const group = bubble.closest('.message-group');
          if (group) {
            if (bubble.classList.contains('show-actions')) {
              group.classList.add('show-timestamp');
            } else if (!group.querySelector('.bubble.show-actions')) {
              group.classList.remove('show-timestamp');
            }
          }
        }
      }
    }
  },

  onEnd() {
    this.reset();
  },

  onMove(event) {
    if (!this.elem) return;
    const dx = event.touches[0].clientX - this.startX;
    const dy = event.touches[0].clientY - this.startY;
    if (dx * dx + dy * dy > 225) this.reset();
  },

  onStart(event) {
    if (event.touches.length > 1) return;
    const target = event.target.closest(
      '.file-card, .bubble-embed-container, .audio-player'
    );
    if (!target) return;

    this.elem = target;
    this.startX = event.touches[0].clientX;
    this.startY = event.touches[0].clientY;
    this.blockClick = false;
    clearTimeout(this.timer);

    this.timer = setTimeout(() => {
      if (!this.elem) return;
      this.blockClick = true;
      this.elem.classList.add('long-pressing');
      if (navigator.vibrate) navigator.vibrate(50);

      const bubble = this.elem.closest('.bubble');
      if (bubble && bubble.dataset.content) {
        setTimeout(() => {
          Utils.triggerDownload(
            bubble.dataset.downloadUrl || bubble.dataset.content,
            bubble.dataset.name
          );
        }, 50);
      }
    }, 300);
  },

  reset() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.elem) {
      this.elem.classList.remove('long-pressing');
      this.elem = null;
    }
  }
};

const Tooltip = {
  hide(btn) {
    if (btn) btn.classList.remove('tooltip-visible');
  },

  reset(btn) {
    if (!btn) return;
    clearTimeout(btn._t);
    btn.classList.remove(
      'tooltip-visible', 'tooltip-error', 'tooltip-success'
    );
    setTimeout(() => {
      if (!btn.classList.contains('tooltip-visible')) {
        btn.setAttribute('data-tooltip', btn.dataset.orig || '');
      }
    }, 200);
  },

  show(btn, msg, type = 'success') {
    if (!btn) return;
    if (btn.dataset.orig === undefined) {
      btn.dataset.orig = btn.getAttribute('data-tooltip') || '';
    }

    clearTimeout(btn._t);
    btn.classList.remove('tooltip-visible');
    void btn.offsetWidth;

    btn.setAttribute('data-tooltip', msg);
    btn.classList.remove('tooltip-error', 'tooltip-success');
    btn.classList.add(
      type === 'error' ? 'tooltip-error' : 'tooltip-success'
    );

    requestAnimationFrame(() => {
      btn.classList.add('tooltip-visible');
    });

    btn._t = setTimeout(() => this.reset(btn), 2000);
  }
};

const UploadManager = {
  loadedBytes: 0,
  processing: false,
  queue: [],
  totalBytes: 0,

  add(files) {
    for (const file of files) this.totalBytes += file.size;
    this.queue.push(...files);
    this.processNext();
  },

  processNext() {
    if (this.processing || !this.queue.length) {
      if (!this.queue.length && this.totalBytes > 0) {
        UI.loader.style.width = '100%';
        setTimeout(() => {
          UI.loader.classList.remove('active');
          UI.loader.style.width = '0%';
          this.totalBytes = this.loadedBytes = 0;
        }, 500);
      }
      return;
    }

    this.processing = true;
    const file = this.queue.shift();

    this.uploadFile(file)
      .then(result => {
        SocketManager.send(
          'file',
          result.url,
          result.name,
          result.type,
          result.size,
          result.downloadUrl
        );
      })
      .catch(error => {
        console.error('Upload failed:', error);
        Toast.show(error.message, 'error');
      })
      .finally(() => {
        this.loadedBytes += file.size;
        this.updateProgress(0);
        this.processing = false;
        this.processNext();
      });
  },

  updateProgress(currentFileBytes) {
    if (!this.totalBytes) return;
    const current = this.loadedBytes + currentFileBytes;
    const percent = Math.min(
      current / this.totalBytes * 100,
      100
    );
    UI.loader.classList.add('active');
    UI.loader.style.width = `${percent}%`;
  },

  async resumeKey(file) {
    if (!globalThis.crypto?.subtle) return null;

    try {
      const source = [
        file.name,
        file.size,
        file.lastModified
      ].join('\0');
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(source)
      );
      const hex = Array.from(
        new Uint8Array(digest),
        byte => byte.toString(16).padStart(2, '0')
      ).join('');
      return `synced-upload:${hex}`;
    } catch {
      return null;
    }
  },

  purgeResume() {
    const now = Date.now();

    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (!key?.startsWith('synced-upload:')) continue;

        let value = null;

        try {
          value = JSON.parse(localStorage.getItem(key));
        } catch {}

        const valid = value &&
          /^[a-f0-9]{32}$/.test(value.uploadId) &&
          Number.isSafeInteger(value.savedAt) &&
          value.savedAt > 0 &&
          value.savedAt <= now &&
          now - value.savedAt <= CONFIG.RESUME_STORAGE_TTL;

        if (!valid) localStorage.removeItem(key);
      }
    } catch {}
  },

  loadResume(key) {
    if (!key) return null;

    try {
      const value = JSON.parse(localStorage.getItem(key));
      const now = Date.now();

      if (
        !value ||
        !/^[a-f0-9]{32}$/.test(value.uploadId) ||
        !Number.isSafeInteger(value.savedAt) ||
        value.savedAt <= 0 ||
        value.savedAt > now ||
        now - value.savedAt > CONFIG.RESUME_STORAGE_TTL
      ) {
        localStorage.removeItem(key);
        return null;
      }

      return value;
    } catch {
      return null;
    }
  },

  saveResume(key, uploadId) {
    if (!key) return;

    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          uploadId,
          savedAt: Date.now()
        })
      );
    } catch {}
  },

  clearResume(key) {
    if (!key) return;

    try {
      localStorage.removeItem(key);
    } catch {}
  },

  error(message, status = 0) {
    const error = new Error(message);
    error.status = status;
    return error;
  },

  async responseError(response, fallback) {
    let message = fallback;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {}
    return this.error(message, response.status);
  },

  stateFromData(data) {
    const offset = Number(data.offset);
    const length = Number(data.length);
    const chunkSize = Number(data.chunkSize);

    if (
      !data ||
      !/^[a-f0-9]{32}$/.test(data.uploadId) ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      !Number.isSafeInteger(chunkSize) ||
      offset < 0 ||
      length < 0 ||
      offset > length ||
      chunkSize <= 0
    ) {
      throw this.error('Invalid upload response');
    }

    return {
      uploadId: data.uploadId,
      offset,
      length,
      chunkSize,
      complete: data.complete === true,
      result: data.complete === true ? data : null
    };
  },

  async initialize(file) {
    const response = await fetch('/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: file.name,
        size: file.size
      })
    });

    if (!response.ok) {
      throw await this.responseError(
        response,
        `Unable to start upload (${response.status})`
      );
    }

    return this.stateFromData(await response.json());
  },

  async head(uploadId) {
    const response = await fetch('/upload', {
      method: 'HEAD',
      cache: 'no-store',
      headers: { 'Upload-Id': uploadId }
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      throw this.error(
        `Unable to read upload status (${response.status})`,
        response.status
      );
    }

    const offset = Number(response.headers.get('Upload-Offset'));
    const length = Number(response.headers.get('Upload-Length'));
    const chunkSize = Number(
      response.headers.get('Upload-Chunk-Size')
    );
    const complete =
      response.headers.get('Upload-Complete') === 'true';

    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      !Number.isSafeInteger(chunkSize) ||
      offset < 0 ||
      length < 0 ||
      offset > length ||
      chunkSize <= 0
    ) {
      throw this.error('Invalid upload status');
    }

    const result = complete ? {
      uploadId,
      offset,
      length,
      chunkSize,
      complete: true,
      url: response.headers.get('Upload-URL'),
      downloadUrl: response.headers.get('Upload-Download-URL'),
      name: response.headers.get('Upload-Name'),
      size: length,
      type: response.headers.get('Upload-Type') ||
        'application/octet-stream'
    } : null;

    if (
      complete &&
      (!result.url || !result.downloadUrl || !result.name)
    ) {
      throw this.error('Incomplete upload status');
    }

    return {
      uploadId,
      offset,
      length,
      chunkSize,
      complete,
      result
    };
  },

  async prepare(file, resumeKey) {
    const resume = this.loadResume(resumeKey);

    if (resume) {
      const state = await this.head(resume.uploadId);

      if (state && state.length === file.size) return state;
      this.clearResume(resumeKey);
    }

    const state = await this.initialize(file);

    if (state.length !== file.size) {
      throw this.error('Upload session does not match file');
    }

    if (!state.complete) {
      this.saveResume(resumeKey, state.uploadId);
    }

    return state;
  },

  patch(uploadId, offset, chunk) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PATCH', '/upload');
      xhr.setRequestHeader('Upload-Id', uploadId);
      xhr.setRequestHeader('Upload-Offset', String(offset));
      xhr.setRequestHeader(
        'Content-Type',
        'application/octet-stream'
      );

      xhr.upload.onprogress = event => {
        if (event.lengthComputable) {
          this.updateProgress(offset + event.loaded);
        }
      };

      xhr.onload = () => {
        if (xhr.status === 200) {
          try {
            resolve({
              complete: true,
              result: JSON.parse(xhr.responseText)
            });
          } catch {
            reject(this.error('Invalid completion response'));
          }
          return;
        }

        if (xhr.status === 204) {
          const nextOffset = Number(
            xhr.getResponseHeader('Upload-Offset')
          );
          if (
            !Number.isSafeInteger(nextOffset) ||
            nextOffset <= offset ||
            nextOffset > offset + chunk.size
          ) {
            reject(this.error('Invalid chunk response'));
            return;
          }
          resolve({ complete: false, offset: nextOffset });
          return;
        }

        let message = `Chunk upload failed (${xhr.status})`;
        try {
          const body = JSON.parse(xhr.responseText);
          if (body?.error) message = body.error;
        } catch {}

        reject(this.error(message, xhr.status));
      };

      xhr.onerror = () => {
        reject(this.error('Network error during upload'));
      };

      xhr.send(chunk);
    });
  },

  retryable(error) {
    return !error.status ||
      error.status === 409 ||
      error.status === 429 ||
      error.status >= 500;
  },

  wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  async recover(uploadId, attempt) {
    let lastError = null;

    for (let i = 0; i < 3; i++) {
      const delay = Math.min(
        1000 * Math.pow(2, attempt + i - 1),
        8000
      );
      await this.wait(delay);

      try {
        return await this.head(uploadId);
      } catch (error) {
        lastError = error;
        if (!this.retryable(error)) throw error;
      }
    }

    throw lastError || this.error('Unable to resume upload');
  },

  async uploadFile(file) {
    const resumeKey = await this.resumeKey(file);
    let state = await this.prepare(file, resumeKey);

    if (state.complete) {
      this.clearResume(resumeKey);
      return state.result;
    }

    let offset = state.offset;
    let chunkSize = state.chunkSize;
    let failures = 0;

    this.updateProgress(offset);

    while (offset < file.size) {
      const end = Math.min(offset + chunkSize, file.size);
      const chunk = file.slice(offset, end);

      try {
        const response = await this.patch(
          state.uploadId,
          offset,
          chunk
        );

        failures = 0;

        if (response.complete) {
          this.clearResume(resumeKey);
          return response.result;
        }

        offset = response.offset;
        this.saveResume(resumeKey, state.uploadId);
        this.updateProgress(offset);
      } catch (error) {
        if (!this.retryable(error) || ++failures > 5) throw error;

        console.warn('Upload interrupted; reconciling offset.');

        state = await this.recover(state.uploadId, failures);
        if (!state) {
          this.clearResume(resumeKey);
          throw this.error('Upload session expired', 404);
        }

        if (state.length !== file.size) {
          this.clearResume(resumeKey);
          throw this.error('Upload session does not match file');
        }

        if (state.complete) {
          this.clearResume(resumeKey);
          return state.result;
        }

        offset = state.offset;
        chunkSize = state.chunkSize;
        this.saveResume(resumeKey, state.uploadId);
        this.updateProgress(offset);
      }
    }

    state = await this.head(state.uploadId);
    if (state?.complete) {
      this.clearResume(resumeKey);
      return state.result;
    }

    throw this.error('Upload finished without finalization');
  }
};

UploadManager.purgeResume();

const PreviewManager = {
  _clearTimer: null,
  _tempPdfUrl: null,
  abortController: null,
  autoFullscreenAllowed: true,
  current: null,
  fullscreenMode: 'none',
  lockPromise: Promise.resolve(),
  mediaElement: null,

  async applyOrientationLock(force = false) {
    if (!this.isValidVideo()) return;
    if (this.fullscreenMode !== 'manual') return;

    const vidOrient = this.getVideoOrientation();
    if (!vidOrient) return;

    if (!force) {
      const currentType = screen.orientation?.type;
      if (currentType && currentType.startsWith(vidOrient)) return;
    }

    this.lockPromise = this.lockPromise.then(async () => {
      try {
        if (screen.orientation?.lock) {
          await screen.orientation.lock(vidOrient);
        }
      } catch (error) {
        console.warn('Orientation lock failed:', error);
      }
    });
  },

  checkAutoLayout() {
    if (!this.isValidVideo()) return;

    const devOrient = this.getDeviceOrientation();
    const vidOrient = this.getVideoOrientation();
    const isFS = this.isInFullscreen();

    if (this.fullscreenMode === 'auto' && isFS) {
      this.unlockScreen();
    }

    if (devOrient === 'portrait') {
      this.autoFullscreenAllowed = true;
      if (this.fullscreenMode === 'auto' && isFS) {
        this.exitFullscreen();
      }
      return;
    }

    if (devOrient === 'landscape') {
      if (!this.isMobileLayout()) return;
      if (!UI.modal.classList.contains('active')) return;
      if (this.fullscreenMode !== 'none') return;
      if (!this.autoFullscreenAllowed) return;

      if (vidOrient === 'landscape' && !isFS) {
        this.enterFullscreen('auto').catch(error => {
          console.warn('Automatic fullscreen failed:', error);
        });
      }
    }
  },

  cleanup() {
    if (this._tempPdfUrl) {
      URL.revokeObjectURL(this._tempPdfUrl);
      this._tempPdfUrl = null;
    }
  },

  close() {
    clearTimeout(this._clearTimer);
    const wasActive = UI.modal.classList.contains('active');
    if (!this.current && !wasActive) return;

    if (this.mediaElement) {
      try {
        this.mediaElement.pause();
      } catch {}
    }

    this.abortController?.abort();
    this.abortController = null;

    this.exitFullscreen();
    this.fullscreenMode = 'none';
    this.unlockScreen();
    this.cleanup();

    UI.modal.classList.remove('active');

    const doClear = () => {
      if (this.mediaElement) {
        this.mediaElement.removeAttribute('src');
        this.mediaElement.load();
        this.mediaElement = null;
      }
      UI.previewStage.innerHTML = '';
      UI.modalContent.innerHTML = '';
      this.current = null;
    };

    if (wasActive) {
      this._clearTimer = setTimeout(() => {
        if (UI.modal.classList.contains('active')) return;
        doClear();
      }, 300);
    } else {
      doClear();
    }
  },

  async copyContent(btn) {
    if (!this.current) return;
    const { type, size, url } = this.current;

    if (size > CONFIG.COPY_LIMIT_SIZE) {
      return Tooltip.show(btn, 'Too Large', 'error');
    }

    if (!navigator.clipboard || !navigator.clipboard.write) {
      console.error('Clipboard API unavailable.');
      return Tooltip.show(btn, 'Not Supported', 'error');
    }

    const isImg = type.startsWith('image/') &&
      type !== 'image/svg+xml';
    const isTxt = type.match(/text|json|javascript|xml|svg/) ||
      type === 'image/svg+xml';

    if (!isImg && !isTxt) {
      return Tooltip.show(btn, 'Not Supported', 'error');
    }

    const oldHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    try {
      if (isImg) {
        const pngPromise = new Promise(async (resolve, reject) => {
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Status ${res.status}`);
            const blob = await res.blob();
            const bitmap = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            bitmap.close();

            canvas.toBlob(pngBlob => {
              if (pngBlob) resolve(pngBlob);
              else reject(new Error('Canvas toBlob failed'));
            }, 'image/png', 1.0);
          } catch (error) {
            reject(error);
          }
        });

        const item = new ClipboardItem({ 'image/png': pngPromise });
        await navigator.clipboard.write([item]);
      } else {
        const res = await fetch(url);
        const text = await res.text();
        await navigator.clipboard.writeText(text);
      }
      Tooltip.show(btn, 'Copied!');
    } catch (error) {
      console.error('Content copy failed:', error);
      Tooltip.show(btn, 'Failed', 'error');
    } finally {
      btn.innerHTML = oldHtml;
      btn.disabled = false;
    }
  },

  copyLink(btn) {
    if (!this.current) return;
    const url = new URL(this.current.url, location.origin).href;
    navigator.clipboard.writeText(url)
      .then(() => Tooltip.show(btn, 'Copied!'))
      .catch(error => {
        console.error('Link copy failed:', error);
        Tooltip.show(btn, 'Failed', 'error');
      });
  },

  createCard(icon, name, label, actionBtn) {
    const card = document.createElement('div');
    card.className = 'preview-card';
    card.innerHTML = `
      <div class="card-content">
        <i class="fas ${icon} card-icon"></i>
        <div class="card-label"></div>
      </div>`;

    const labelElement = card.querySelector('.card-label');
    labelElement.textContent = name;
    labelElement.title = name;

    if (label) {
      const sub = document.createElement('div');
      sub.className = 'card-sub';
      sub.textContent = label;
      card.querySelector('.card-content').appendChild(sub);
    }
    if (actionBtn) {
      actionBtn.classList.add('card-action');
      card.querySelector('.card-content').appendChild(actionBtn);
    }
    return card;
  },

  download(btn) {
    if (!this.current) return;
    Utils.triggerDownload(
      this.current.downloadUrl || this.current.url,
      this.current.name
    );
    Tooltip.show(btn, 'Started!');
  },

  async enterFullscreen(mode) {
    if (!this.mediaElement) return;
    this.fullscreenMode = mode;
    try {
      if (this.mediaElement.requestFullscreen) {
        await this.mediaElement.requestFullscreen();
      } else if (this.mediaElement.webkitEnterFullscreen) {
        this.mediaElement.webkitEnterFullscreen();
      } else if (this.mediaElement.webkitRequestFullscreen) {
        await this.mediaElement.webkitRequestFullscreen();
      }
    } catch (error) {
      this.fullscreenMode = 'none';
      throw error;
    }
  },

  exitFullscreen() {
    try {
      const documentRef = document;
      if (
        documentRef.fullscreenElement ||
        documentRef.webkitFullscreenElement
      ) {
        if (documentRef.exitFullscreen) {
          documentRef.exitFullscreen().catch(error => {
            console.warn('Fullscreen exit failed:', error);
          });
        } else if (documentRef.webkitExitFullscreen) {
          documentRef.webkitExitFullscreen();
        }
      }
    } catch {}
    try {
      if (this.mediaElement?.webkitDisplayingFullscreen) {
        this.mediaElement.webkitExitFullscreen();
      }
    } catch {}
  },

  getDeviceOrientation() {
    if (screen.orientation?.type) {
      if (screen.orientation.type.includes('landscape')) {
        return 'landscape';
      }
      if (screen.orientation.type.includes('portrait')) {
        return 'portrait';
      }
    }
    if (window.matchMedia('(orientation: landscape)').matches) {
      return 'landscape';
    }
    return 'portrait';
  },

  getFsElement() {
    return document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement;
  },

  getVideoOrientation() {
    if (!this.isValidVideo()) return null;
    return this.mediaElement.videoWidth >=
      this.mediaElement.videoHeight ? 'landscape' : 'portrait';
  },

  handleFullscreenExit() {
    if (this.fullscreenMode === 'auto' &&
      this.getDeviceOrientation() === 'landscape') {
      this.autoFullscreenAllowed = false;
    }
    this.fullscreenMode = 'none';
    this.unlockScreen();
  },

  init() {
    const allTooltipBtns = [...UI.copyContentBtns, ...UI.actionBtns];
    allTooltipBtns.forEach(button => {
      if (button) {
        button.dataset.orig =
          button.getAttribute('data-tooltip') || '';
      }
    });

    const bind = (btn, fn) => {
      if (!btn) return;
      btn.addEventListener('click', event => {
        event.stopPropagation();
        fn(btn);
      });
    };

    UI.copyContentBtns.forEach(button =>
      bind(button, btn => this.copyContent(btn)));

    const copyLink = button => this.copyLink(button);
    const download = button => this.download(button);

    [0, 2].forEach(i => bind(UI.actionBtns[i], copyLink));
    [1, 3].forEach(i => bind(UI.actionBtns[i], download));

    UI.modalCloseBtn.onclick = () => this.close();
    UI.modal.onclick = event => {
      const isOut = event.target === UI.modal ||
        event.target.classList.contains('modal-overlay') ||
        event.target.classList.contains('modal-container') ||
        event.target.classList.contains('modal-content');
      if (isOut) this.close();
    };

    const fsHandler = () => this.onFullscreenChange();
    document.addEventListener('fullscreenchange', fsHandler);
    document.addEventListener('webkitfullscreenchange', fsHandler);
    document.addEventListener('mozfullscreenchange', fsHandler);
    document.addEventListener('MSFullscreenChange', fsHandler);

    const onResize = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() =>
        this.checkAutoLayout(), 200);
    };

    if (screen.orientation) {
      screen.orientation.addEventListener('change', onResize);
    }
    window.addEventListener('orientationchange', onResize);
    window.addEventListener('resize', onResize);

    const mq = window.matchMedia(
      `(min-width: ${CONFIG.MOBILE_BREAKPOINT}px)`
    );
    mq.addEventListener('change', () => {
      if (!this.isInFullscreen()) this.render();
    });
  },

  isInFullscreen() {
    const fsEl = this.getFsElement();
    if (fsEl) {
      if (fsEl === this.mediaElement) return true;
      if (fsEl.contains?.(this.mediaElement)) return true;
    }
    if (this.mediaElement?.webkitDisplayingFullscreen) return true;
    return false;
  },

  isMobileLayout() {
    return window.innerWidth < CONFIG.MOBILE_BREAKPOINT;
  },

  isValidVideo() {
    return this.mediaElement &&
      this.mediaElement.tagName === 'VIDEO' &&
      this.mediaElement.readyState >= 1;
  },

  onFullscreenChange() {
    const isFS = this.isInFullscreen();
    if (isFS) {
      if (this.fullscreenMode === 'none') {
        this.fullscreenMode = 'manual';
      }
      if (this.fullscreenMode === 'manual') {
        this.applyOrientationLock();
      } else if (this.fullscreenMode === 'auto') {
        this.unlockScreen();
      }
    } else {
      this.handleFullscreenExit();
    }
  },

  open(url, downloadUrl, type, name, size) {
    this.close();
    this.current = { url, downloadUrl, type, name, size };
    this.render();
  },

  async render() {
    if (!this.current) return;
    if (this.isInFullscreen()) return;

    this.cleanup();

    const isDesk = !this.isMobileLayout();
    const container = isDesk ? UI.previewStage : UI.modalContent;

    if (isDesk) UI.modal.classList.remove('active');
    else UI.modal.classList.add('active');

    const { type, url, name, size } = this.current;
    const isSafe = url.startsWith('/uploads/');

    if (this.mediaElement &&
      this.mediaElement.dataset.src === url) {
      if (!container.contains(this.mediaElement)) {
        this.mediaElement.className = isDesk
          ? 'preview-item layout-fit'
          : 'modal-preview-item layout-fit';
        container.innerHTML = '';
        container.appendChild(this.mediaElement);
      }
      return;
    }

    if (this.mediaElement) {
      this.mediaElement.pause();
      this.mediaElement.removeAttribute('src');
      this.mediaElement.load();
      this.mediaElement = null;
    }

    this.abortController = new AbortController();
    container.innerHTML =
      '<div class="loader-spinner">Loading...</div>';

    let node;
    const isMobilePdf = type === 'application/pdf' &&
      /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) &&
      !/Firefox/i.test(navigator.userAgent);

    if (size === 0) {
      node = this.createCard('fa-file-alt', 'File empty');
    } else if (!isSafe) {
      node = this.createCard('fa-shield-alt', 'Blocked');
    } else if (Utils.isWebSafe(type) &&
      type.startsWith('image/')) {
      node = this.renderImage(url);
    } else if (Utils.isWebSafe(type) &&
      type.startsWith('video/')) {
      node = this.renderVideo(url);
    } else if (type.startsWith('audio/')) {
      node = this.renderAudio(url);
    } else if (type === 'application/pdf') {
      node = this.renderPdf(url, name, isMobilePdf);
    } else if (type?.startsWith('text/') ||
      type?.includes('json')) {
      node = await this.renderText(url, size);
    } else {
      node = this.renderCard(type, name, size);
    }

    container.innerHTML = '';
    const isFill = size > 0 &&
      ((type === 'application/pdf' && !isMobilePdf) ||
        ((type?.startsWith('text/') || type?.includes('json')) &&
          size <= CONFIG.TEXT_PREVIEW_LIMIT));

    node.classList.add(
      isDesk ? 'preview-item' : 'modal-preview-item'
    );
    node.classList.add(isFill ? 'layout-fill' : 'layout-fit');
    container.appendChild(node);

    const canCopy = type?.match(
      /text|image|json|javascript|typescript|xml|svg/
    );
    UI.copyContentBtns.forEach(button => {
      if (button) button.disabled = !canCopy;
    });
    UI.actionBtns.forEach(button => {
      if (button) button.disabled = false;
    });
  },

  renderAudio(url) {
    const node = document.createElement('audio');
    node.src = url;
    node.dataset.src = url;
    node.controls = node.autoplay = true;
    node.className = 'media-content';
    this.mediaElement = node;
    return node;
  },

  renderCard(type, name, size) {
    return this.createCard(
      Utils.getIcon(type),
      name,
      Utils.formatSize(size)
    );
  },

  renderImage(url) {
    const node = document.createElement('img');
    node.src = url;
    node.className = 'media-content';
    return node;
  },

  renderPdf(url, name, isMobilePdf) {
    if (isMobilePdf) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.className = 'fallback-action-link';
      link.innerHTML =
        'Open externally <i class="fas fa-external-link-alt"></i>';
      return this.createCard(
        'fa-file-pdf',
        name,
        'Preview unavailable',
        link
      );
    }

    const node = document.createElement('iframe');
    node.src = url;
    node.className = 'media-content media-frame';
    node.setAttribute('sandbox', 'allow-scripts allow-popups');
    return node;
  },

  async renderText(url, size) {
    if (size > CONFIG.TEXT_PREVIEW_LIMIT) {
      return this.createCard('fa-file-alt', 'File too large');
    }

    const pre = document.createElement('pre');
    pre.className = 'text-preview';

    try {
      const res = await fetch(url, {
        signal: this.abortController.signal
      });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      pre.textContent = await res.text();
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Text preview failed:', error);
      }
      pre.textContent = 'Error loading preview.';
    }

    return pre;
  },

  renderVideo(url) {
    const node = document.createElement('video');
    node.src = url;
    node.dataset.src = url;
    node.controls = node.autoplay = node.playsInline = true;
    node.className = 'media-content';
    node.style.opacity = '0';
    node.style.transition = 'opacity 0.2s';

    const enforceLock = (force = false) => {
      if (this.fullscreenMode === 'manual') {
        this.applyOrientationLock(force);
      }
    };

    node.addEventListener('loadedmetadata', () => {
      this.checkAutoLayout();
      enforceLock();
    }, { once: true });

    node.addEventListener('loadeddata', () => {
      node.style.opacity = '1';
    });

    node.addEventListener('play', () => {
      enforceLock();
      if (this.fullscreenMode === 'auto') {
        this.unlockScreen();
      } else if (this.fullscreenMode === 'none' &&
        this.isMobileLayout()) {
        const deviceOrientation = this.getDeviceOrientation();
        const videoOrientation = this.getVideoOrientation();
        if (
          deviceOrientation === 'landscape' &&
          videoOrientation === 'landscape'
        ) {
          this.enterFullscreen('auto').catch(() => {});
        }
      }
    });

    node.addEventListener('seeking', () => enforceLock());

    node.addEventListener('pause', () => {
      enforceLock(true);
      if (this.fullscreenMode === 'auto') this.unlockScreen();
    });

    node.addEventListener('ended', () => {
      enforceLock(true);
      if (this.fullscreenMode === 'auto') this.unlockScreen();
    });

    node.addEventListener('webkitbeginfullscreen', () => {
      if (this.fullscreenMode === 'none') {
        this.fullscreenMode = 'manual';
      }
      enforceLock();
    });

    node.addEventListener('webkitendfullscreen', () => {
      this.handleFullscreenExit();
    });

    node.addEventListener('error', () => {
      console.error('Video element failed:', node.error);
    });

    this.mediaElement = node;
    return node;
  },

  unlockScreen() {
    try {
      if (screen.orientation?.unlock) {
        screen.orientation.unlock();
      }
    } catch (error) {
      console.warn('Screen orientation unlock failed:', error);
    }
  }
};

const MediaPreloader = {
  load(msg) {
    return new Promise(resolve => {
      const type = msg.fileType || '';
      if (!type.startsWith('image/') &&
        !type.startsWith('video/')) {
        resolve(null);
        return;
      }
      if (!Utils.isWebSafe(type)) {
        resolve(null);
        return;
      }

      if (type.startsWith('video/')) {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.className = 'embed-media';
        video.src = msg.content;

        const finish = result => {
          video.onloadeddata = null;
          video.onerror = null;
          clearTimeout(timer);
          resolve(result);
        };

        const timer = setTimeout(() => {
          console.warn('Media preload timed out.');
          finish(null);
        }, 5000);
        video.onloadeddata = () => finish(video);
        video.onerror = () => {
          console.error('Media preload failed.');
          finish(null);
        };
        return;
      }

      const image = new Image();
      image.className = 'embed-media';
      image.src = msg.content;

      const finish = result => {
        image.onload = null;
        image.onerror = null;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        console.warn('Media preload timed out.');
        finish(null);
      }, 5000);
      image.onload = () => finish(image);
      image.onerror = () => {
        console.error('Media preload failed.');
        finish(null);
      };
    });
  }
};

const MessageRenderer = {
  domCount: 0,
  domSize: 0,
  lastCat: null,
  lastId: null,
  lastTime: 0,

  getCat(msg) {
    if (msg.type === 'text') return 'text';
    const mime = msg.fileType || '';
    if (
      (mime.startsWith('image/') || mime.startsWith('video/')) &&
      Utils.isWebSafe(mime)
    ) {
      return 'media';
    }
    return 'file';
  },

  prune() {
    const MAX_CNT = 1000;
    const MAX_MEM = 256 * 1024 * 1024;

    while (this.domCount > MAX_CNT || this.domSize > MAX_MEM) {
      const top = UI.messageList.firstElementChild;
      if (!top) break;

      if (top.classList.contains('message-group')) {
        const bubble = top.querySelector('.bubble');
        if (bubble) {
          this.domSize -= parseInt(bubble.dataset.memSize || 0);
          this.domCount--;
          bubble.remove();
        }
        if (!top.querySelector('.bubble')) top.remove();
      } else {
        top.remove();
      }
    }
  },

  render(msg, preloadedNode = null) {
    const isMe = msg.senderId === socket.id;
    const time = msg.timestamp || Date.now();
    const category = this.getCat(msg);

    if (!msg.isPending && msg.tempId) {
      const pending = document.getElementById(msg.tempId);
      if (pending) {
        pending.classList.remove('pending');
        pending.removeAttribute('id');
        if (msg.content) pending.dataset.content = msg.content;
        if (msg.downloadUrl) {
          pending.dataset.downloadUrl = msg.downloadUrl;
        }
        if (msg.fileType) pending.dataset.type = msg.fileType;
        if (msg.size !== undefined) {
          pending.dataset.size = msg.size;
        }
        if (msg.name) pending.dataset.name = msg.name;
        const size = pending.querySelector('.file-size');
        if (size) size.textContent = Utils.formatSize(msg.size);
        return;
      }
    }

    if (!msg.isPending && isMe &&
      document.getElementById(msg.tempId)) {
      return;
    }

    const isNew = this.lastId !== msg.senderId ||
      time - this.lastTime > 60000 ||
      this.lastCat !== category;

    if (isNew) {
      const group = document.createElement('div');
      group.className =
        `message-group ${isMe ? 'me' : 'them'}`;
      const hue = msg.hue ?? 0;
      group.style.setProperty(
        '--user-color',
        `hsl(${hue}, 50%, 50%)`
      );

      const timestamp = document.createElement('div');
      timestamp.className = 'group-timestamp';
      timestamp.textContent = Utils.formatTime(time);
      group.appendChild(timestamp);
      UI.messageList.appendChild(group);
      this.lastId = msg.senderId;
      this.lastTime = time;
    }

    const group = UI.messageList.lastElementChild;
    const bubble = document.createElement('div');
    bubble.className =
      `bubble ${msg.isPending ? 'pending' : ''}`;
    if (msg.tempId) bubble.id = msg.tempId;

    if (msg.type === 'text') {
      const text = document.createElement('div');
      text.className = 'bubble-text';
      text.appendChild(Utils.linkify(msg.content));
      bubble.appendChild(text);

      const actions = document.createElement('div');
      actions.className = 'bubble-actions';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'bubble-copy-btn';
      copyBtn.innerHTML = '<i class="far fa-copy"></i>';
      copyBtn.setAttribute('aria-label', 'Copy message');
      copyBtn.setAttribute('title', 'Copy message');

      let isCopied = false;
      let flashTimeout;
      let revertTimeout;

      copyBtn.onclick = async () => {
        if (!navigator.clipboard) {
          console.error('Clipboard API unavailable.');
          Toast.show('Failed to copy', 'error');
          return;
        }

        try {
          await navigator.clipboard.writeText(msg.content);
          clearTimeout(revertTimeout);
          clearTimeout(flashTimeout);

          if (isCopied) {
            copyBtn.innerHTML = '<i class="far fa-copy"></i>';
            flashTimeout = setTimeout(() => {
              copyBtn.innerHTML = '<i class="fas fa-check"></i>';
            }, 100);
          } else {
            isCopied = true;
            copyBtn.innerHTML = '<i class="fas fa-check"></i>';
          }

          if (window.matchMedia('(hover: none)').matches) {
            revertTimeout = setTimeout(() => {
              bubble.classList.remove('show-actions');
              const parentGroup =
                bubble.closest('.message-group');
              if (
                parentGroup &&
                !parentGroup.querySelector(
                  '.bubble.show-actions'
                )
              ) {
                parentGroup.classList.remove('show-timestamp');
              }
            }, 2000);
          }
        } catch (error) {
          console.error('Clipboard write failed:', error);
          Toast.show('Failed to copy', 'error');
        }
      };

      actions.addEventListener('transitionend', event => {
        if (event.propertyName === 'opacity') {
          const opacity = parseFloat(
            window.getComputedStyle(actions).opacity
          );
          if (opacity === 0 && isCopied) {
            isCopied = false;
            copyBtn.innerHTML = '<i class="far fa-copy"></i>';
          }
        }
      });

      actions.appendChild(copyBtn);
      bubble.appendChild(actions);
    } else {
      const mime =
        msg.fileType || 'application/octet-stream';
      const isEmbed =
        (mime.startsWith('image/') ||
          mime.startsWith('video/')) &&
        Utils.isWebSafe(mime);
      const isAudio = mime.startsWith('audio/');

      bubble.dataset.content = msg.content;
      bubble.dataset.downloadUrl =
        msg.downloadUrl || msg.content;
      bubble.dataset.type = mime;
      bubble.dataset.name = msg.name;
      bubble.dataset.size = msg.size;

      const open = () => {
        PreviewManager.open(
          bubble.dataset.content,
          bubble.dataset.downloadUrl,
          bubble.dataset.type,
          bubble.dataset.name,
          parseInt(bubble.dataset.size)
        );
      };

      if (isAudio) {
        bubble.classList.add('file-bubble');
        const player = AudioFactory.create(
          msg.content,
          msg.name
        );
        bubble.appendChild(player);
      } else if (isEmbed) {
        bubble.classList.add('embed-bubble');
        const wrapper = document.createElement('div');
        wrapper.className = 'bubble-embed-container';
        wrapper.onclick = open;

        if (preloadedNode) {
          if (preloadedNode.tagName === 'VIDEO') {
            const ratio =
              preloadedNode.videoWidth /
              preloadedNode.videoHeight;
            if (ratio && isFinite(ratio)) {
              wrapper.style.aspectRatio = String(ratio);
            }
          } else if (preloadedNode.tagName === 'IMG') {
            const ratio =
              preloadedNode.naturalWidth /
              preloadedNode.naturalHeight;
            if (ratio && isFinite(ratio)) {
              wrapper.style.aspectRatio = String(ratio);
            }
          }

          wrapper.appendChild(preloadedNode);
          if (preloadedNode.tagName === 'VIDEO') {
            const overlay = document.createElement('div');
            overlay.className = 'play-icon-overlay';
            overlay.innerHTML = '<i class="fas fa-play"></i>';
            wrapper.appendChild(overlay);
          }
        } else if (mime.startsWith('video')) {
          const media = document.createElement('video');
          media.className = 'embed-media';
          media.muted = true;
          media.playsInline = true;
          media.preload = 'metadata';
          media.src = msg.content;
          media.onloadeddata = () => {
            media.currentTime = 0.001;
          };
          wrapper.appendChild(media);

          const overlay = document.createElement('div');
          overlay.className = 'play-icon-overlay';
          overlay.innerHTML = '<i class="fas fa-play"></i>';
          wrapper.appendChild(overlay);
        } else {
          const media = document.createElement('img');
          media.className = 'embed-media';
          media.src = msg.content;
          wrapper.appendChild(media);
        }

        bubble.appendChild(wrapper);
      } else {
        bubble.classList.add('file-bubble');
        const card = document.createElement('div');
        card.className = 'file-card';
        card.onclick = open;
        const icon = Utils.getIcon(mime);
        card.innerHTML = `
          <div class="file-icon-wrapper">
            <i class="fas ${icon}"></i>
          </div>
          <div class="file-meta">
            <span class="file-name"></span>
            <span class="file-size"></span>
          </div>`;
        card.querySelector('.file-name').textContent = msg.name;
        card.querySelector('.file-size').textContent =
          msg.isPending
            ? 'Uploading...'
            : Utils.formatSize(msg.size);
        bubble.appendChild(card);
      }
    }

    const memory = (msg.content || '').length;
    bubble.dataset.memSize = memory;
    this.domSize += memory;
    this.domCount++;

    group.insertBefore(bubble, group.lastElementChild);
    this.prune();

    this.lastCat = category;
    this.scrollToBottom();
  },

  reset() {
    this.domCount = 0;
    this.domSize = 0;
    this.lastCat = null;
    this.lastId = null;
    this.lastTime = 0;
    UI.messageList.innerHTML = '';
  },

  scrollToBottom() {
    UI.messageList.scrollTo({
      top: UI.messageList.scrollHeight,
      behavior: 'smooth'
    });
  }
};

const MessageQueue = {
  active: false,
  queue: [],

  enqueue(msg) {
    this.queue.push(msg);
    this.process();
  },

  async process() {
    if (this.active) return;
    this.active = true;

    while (this.queue.length) {
      const msg = this.queue[0];

      if (!msg.isPending && msg.tempId) {
        const element = document.getElementById(msg.tempId);
        if (element) {
          MessageRenderer.render(msg);
          this.queue.shift();
          continue;
        }
      }

      let node = null;
      try {
        node = await MediaPreloader.load(msg);
      } catch (error) {
        console.error('Media preload failed:', error);
      }

      MessageRenderer.render(msg, node);
      this.queue.shift();
    }

    this.active = false;
  }
};

const SocketManager = {
  send(type, content, name, fileType, size, downloadUrl) {
    const tempId =
      `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const payload = {
      type,
      content,
      name,
      fileType,
      size,
      downloadUrl,
      tempId
    };

    MessageQueue.enqueue({
      ...payload,
      senderId: socket.id,
      timestamp: Date.now(),
      hue: myHue,
      isPending: true
    });
    socket.emit('message', payload);
  }
};

socket.on('session', data => {
  myHue = data.hue;
  UI.sendBtn.style.backgroundColor =
    `hsl(${myHue}, 50%, 50%)`;
  UI.sendBtn.style.color = 'white';
});

socket.on('userCountUpdate', count => {
  UI.userCount.textContent = count;
});

socket.on('message', message => {
  MessageQueue.enqueue(message);
});

socket.on('error', error => {
  console.error('Server error:', error);
  Toast.show(error.message || error, 'error');
});

PreviewManager.init();
TouchDelegate.init();

UI.input.addEventListener('focus', () => {
  document.querySelectorAll('.bubble.show-actions').forEach(bubble => {
    bubble.classList.remove('show-actions');
  });
  document.querySelectorAll(
    '.message-group.show-timestamp'
  ).forEach(group => {
    group.classList.remove('show-timestamp');
  });
});

UI.input.onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    UI.sendBtn.click();
  }
};

UI.input.oninput = function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
};

UI.sendBtn.onclick = () => {
  const text = UI.input.value.trim();
  if (!text) return;
  SocketManager.send('text', text);
  UI.input.value = '';
  UI.input.style.height = 'auto';
  UI.input.focus();
};

UI.fileInput.onchange = function() {
  if (this.files.length) {
    UploadManager.add(Array.from(this.files));
  }
  this.value = '';
};

UI.fileBtn.onclick = () => {
  UI.fileInput.click();
};

const ResetController = {
  container: UI.resetBtn.parentElement,
  btn: UI.resetBtn,
  icon: UI.resetBtn.querySelector('.logo-icon'),
  isMobile: !window.matchMedia('(hover: hover)').matches,
  armTimer: null,

  init() {
    if (this.isMobile) {
      this.btn.onclick = event => {
        event.preventDefault();
        this.handleClick();
      };
    } else {
      this.container.onmouseenter = () => this.arm();
      this.container.onmouseleave = () => this.disarm();
      this.btn.onclick = () => {
        if (this.isArmed()) this.execute();
      };
    }
  },

  isArmed() {
    return this.container.classList.contains('armed');
  },

  handleClick() {
    if (this.isArmed()) {
      this.execute();
    } else {
      this.arm();
      clearTimeout(this.armTimer);
      this.armTimer = setTimeout(() => this.disarm(), 3000);
    }
  },

  arm() {
    if (UI.messageList.classList.contains('destructing')) return;
    this.container.classList.add('armed');
  },

  disarm() {
    this.container.classList.remove('armed');
    clearTimeout(this.armTimer);
  },

  async execute() {
    if (UI.messageList.classList.contains('destructing')) return;

    clearTimeout(this.armTimer);

    UI.messageList.classList.add('destructing');
    this.btn.classList.add('spinning');

    const minTime = 600;
    const start = Date.now();

    await Animation.clearChat();
    MessageRenderer.reset();

    const remaining = minTime - (Date.now() - start);

    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining));
    }

    await this.waitForSpinLoop();

    this.btn.classList.remove('spinning');
    this.container.classList.remove('armed');
    UI.messageList.classList.remove('destructing');

    Toast.show('Chat cleared locally');
  },

  waitForSpinLoop() {
    return new Promise(resolve => {
      if (
        getComputedStyle(this.icon).animationName === 'none'
      ) {
        resolve();
        return;
      }

      const handler = () => {
        this.icon.removeEventListener(
          'animationiteration',
          handler
        );
        resolve();
      };
      this.icon.addEventListener(
        'animationiteration',
        handler,
        { once: true }
      );
    });
  }
};

ResetController.init();

let dragCounter = 0;
const isFiles = event =>
  event.dataTransfer.types.includes('Files');

window.ondragenter = event => {
  if (isFiles(event)) {
    event.preventDefault();
    dragCounter++;
    UI.dropOverlay.classList.add('active');
  }
};

window.ondragleave = event => {
  if (isFiles(event)) {
    event.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
      UI.dropOverlay.classList.remove('active');
    }
  }
};

window.ondragover = event => {
  if (isFiles(event)) event.preventDefault();
};

window.ondrop = event => {
  if (isFiles(event)) {
    event.preventDefault();
    dragCounter = 0;
    UI.dropOverlay.classList.remove('active');
    if (event.dataTransfer.files.length) {
      UploadManager.add(
        Array.from(event.dataTransfer.files)
      );
    }
  }
};

window.onpaste = event => {
  const items = Array.from(event.clipboardData.items);
  const files = items
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter(Boolean);

  if (files.length) UploadManager.add(files);
};

if (UI.resizer) {
  let drag = false;

  UI.resizer.onmousedown = () => {
    drag = true;
    UI.resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
  };

  document.onmousemove = event => {
    const min = 320;
    const max = innerWidth - min;
    if (drag && event.clientX >= min && event.clientX <= max) {
      document.querySelector('.app-layout')
        .style.setProperty(
          '--left-pane-width',
          `${event.clientX}px`
        );
    }
  };

  document.onmouseup = () => {
    if (drag) {
      drag = false;
      UI.resizer.classList.remove('dragging');
      document.body.style.cursor = '';
    }
  };
}

document.body.style.opacity = '1';
UI.input.focus();
