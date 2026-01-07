"use strict";

const LogManager = {
  buffer: [],
  limit: 200,

  copy() {
    console.log('Copying internal logs to clipboard.');
    if (!this.buffer.length) return 'No logs.';
    return this.buffer.join('\n');
  },

  init() {
    const replacer = (k, v) => {
      if (typeof v === 'string' && v.startsWith('data:') && v.length > 50) {
        return v.substring(0, 50) + '...';
      }
      return v;
    };

    const push = (level, args) => {
      const msg = args.map(a => {
        try {
          if (typeof a === 'object' && a !== null) {
            return JSON.stringify(a, replacer);
          }
          const s = String(a);
          if (s.startsWith('data:') && s.length > 50) {
            return s.substring(0, 50) + '...';
          }
          return s;
        } catch {
          return String(a);
        }
      }).join(' ');
      const t = new Date().toLocaleTimeString();
      const entry = `[${level}] ${t}: ${msg}`;
      this.buffer.push(entry);
      if (this.buffer.length > this.limit) this.buffer.shift();
    };

    const oLog = console.log;
    const oWarn = console.warn;
    const oErr = console.error;

    console.log = (...a) => {
      push('INF', a);
      oLog.apply(console, a);
    };
    console.warn = (...a) => {
      push('WRN', a);
      oWarn.apply(console, a);
    };
    console.error = (...a) => {
      push('ERR', a);
      oErr.apply(console, a);
    };

    window.addEventListener('error', (e) => {
      const msg = `Global error: ${e.message}`;
      push('ERR', [msg, e.filename, e.lineno]);
    });
    window.addEventListener('unhandledrejection', (e) => {
      push('ERR', ['Unhandled Promise Rejection', e.reason]);
    });
    console.log('LogManager initialized.');
  }
};

LogManager.init();

const socket = io();
console.log('Socket.io client initialized.');

socket.on('connect', () => {
  console.log('Socket connected with ID:', socket.id);
});
socket.on('disconnect', (reason) => {
  const msg = `Socket disconnected: ${reason}`;
  console.log(`${msg}. Socket.io will attempt to reconnect.`);
});
socket.on('connect_error', (error) => {
  console.error('Socket connection error:', error);
});

let myHue = 210;
const TLD_SET = new Set();
let tldsLoaded = false;

console.log('Fetching TLD list...');
fetch('/tlds.txt')
  .then((res) => {
    if (res.ok) return res.text();
    throw new Error(`TLD fetch failed: ${res.status}`);
  })
  .then((text) => {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#') ||
        line.startsWith('XN--')) continue;
      TLD_SET.add(line.toUpperCase());
    }
    tldsLoaded = true;
    console.log(`Loaded ${TLD_SET.size} TLDs.`);
  })
  .catch((err) => {
    console.error('Failed to load TLD list:', err.message);
  });

const ANIM_CONFIG = {
  GRAVITY_BIAS: -0.4,
  PARTICLE_COUNT: 35,
  SPREAD_MULTIPLIER: 350,
  STAGGER_DELAY_MS: 35
};

const CONFIG = {
  COPY_LIMIT_SIZE: 50 * 1024 * 1024,
  MAX_UPLOAD_SIZE: 8 * 1024 * 1024 * 1024,
  MOBILE_BREAKPOINT: 900,
  TEXT_PREVIEW_LIMIT: 2 * 1024 * 1024
};

const Toast = {
  el: null,
  tm: null,

  show(msg, type = 'info') {
    console.log(`Showing toast: "${msg}" (${type})`);
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
    console.log('Debug button clicked.');
    const logs = LogManager.copy();
    navigator.clipboard.writeText(logs)
      .then(() => {
        Toast.show('Logs copied to clipboard');
        console.log('Logs successfully copied.');
      })
      .catch(e => {
        Toast.show('Failed to copy logs', 'error');
        console.error('Failed to copy logs:', e);
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
    console.log(`Triggering download for "${name}"`);
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
    console.log('Starting clear chat animation.');
    const chatPane = UI.messageList.parentElement;
    const bubbles = Array.from(UI.messageList.querySelectorAll('.bubble'));

    const containerRect = chatPane.getBoundingClientRect();
    const visibleItems = [];

    for (const bubble of bubbles) {
      const el = bubble.firstElementChild;
      if (!el) continue;
      const rect = el.getBoundingClientRect();

      const isVisible = (rect.top < containerRect.bottom && rect.bottom > containerRect.top);

      if (isVisible) {
        const style = window.getComputedStyle(el);
        let color = el.classList.contains('bubble-embed-container')
          ? style.borderTopColor
          : style.backgroundColor;

        if (!color || color === 'rgba(0, 0, 0, 0)' || color === 'transparent') {
          color = '#2c2c2e';
        }

        visibleItems.push({
          element: el,
          bubble: bubble,
          rect: rect,
          color: color
        });
      } else {
        bubble.style.visibility = 'hidden';
      }
    }

    if (visibleItems.length === 0) {
      console.log('No visible bubbles to animate.');
      return;
    }

    visibleItems.reverse();
    const promises = [];

    await Utils.nextFrame();

    for (const [i, item] of visibleItems.entries()) {
      const p = new Promise(resolve => {
        setTimeout(() => {
          item.bubble.style.visibility = 'hidden';
          this.explodeRect(item.rect, item.color, chatPane).then(resolve);
        }, i * ANIM_CONFIG.STAGGER_DELAY_MS);
      });
      promises.push(p);
    }

    await Promise.all(promises);
    console.log('Clear chat animation finished.');
  },

  explodeRect(rect, color, container) {
    return new Promise((resolve) => {
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

        const tx = (Math.random() - 0.5) * ANIM_CONFIG.SPREAD_MULTIPLIER;
        const ty = (Math.random() + ANIM_CONFIG.GRAVITY_BIAS) * ANIM_CONFIG.SPREAD_MULTIPLIER;

        const a = p.animate([
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
          { transform: `translate(${tx}px, ${ty}px) scale(0)`, opacity: 0 }
        ], {
          duration: 500 + Math.random() * 400,
          easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)',
          fill: 'forwards'
        });
        anims.push(a.finished);
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
    console.log(`Creating audio player for "${name}".`);
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

    const format = (sec) => {
      if (!sec || isNaN(sec)) return '0:00';
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const updateProgress = () => {
      if (isDragging) return;
      const cur = audio.currentTime;
      const pct = (cur / duration) * 100 || 0;
      slider.value = pct;
      fill.style.width = `${pct}%`;
      timeDisplay.textContent = `${format(cur)} / ${format(duration)}`;
    };

    const toggle = () => {
      if (audio.paused) {
        console.log(`Playing audio: "${name}"`);
        if (AudioFactory.current &&
          AudioFactory.current !== audio) {
          console.log('Pausing other audio instance.');
          AudioFactory.current.pause();
        }
        AudioFactory.current = audio;
        audio.play().catch(e =>
          console.error('Audio play error:', e));
      } else {
        console.log(`Pausing audio: "${name}"`);
        audio.pause();
      }
    };

    btn.onclick = (e) => {
      e.stopPropagation();
      toggle();
    };

    slider.onclick = (e) => e.stopPropagation();

    slider.oninput = () => {
      if (!isDragging) {
        console.log(`Audio seek started: "${name}"`);
        isDragging = true;
      }
      const pct = slider.value;
      fill.style.width = `${pct}%`;
      const time = (pct / 100) * duration;
      timeDisplay.textContent = `${format(time)} / ${format(duration)}`;
    };

    slider.onchange = () => {
      console.log(`Audio seek ended: ${slider.value}% ("${name}")`);
      isDragging = false;
      const time = (slider.value / 100) * duration;
      audio.currentTime = time;
    };

    audio.onloadedmetadata = () => {
      duration = audio.duration;
      console.log(`Audio loaded "${name}": ${duration}s.`);
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

    audio.onerror = (e) => {
      console.error(`Audio error "${name}":`, e.target.error);
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
    list.addEventListener('contextmenu', (e) => {
      if (e.target.closest(
        '.file-card, .bubble-embed-container, .audio-player')) {
        e.preventDefault();
      }
    });
    console.log('TouchDelegate initialized.');
  },

  onClick(e) {
    if (this.blockClick) {
      e.stopImmediatePropagation();
      e.preventDefault();
      this.blockClick = false;
    }
  },

  onEnd() {
    this.reset();
  },

  onMove(e) {
    if (!this.elem) return;
    const dx = e.touches[0].clientX - this.startX;
    const dy = e.touches[0].clientY - this.startY;
    const distSq = dx * dx + dy * dy;
    if (distSq > 225) {
      console.log('Touch move, canceling long press.');
      this.reset();
    }
  },

  onStart(e) {
    if (e.touches.length > 1) return;
    const t = e.target.closest(
      '.file-card, .bubble-embed-container, .audio-player'
    );
    if (!t) return;

    this.elem = t;
    this.startX = e.touches[0].clientX;
    this.startY = e.touches[0].clientY;
    this.blockClick = false;
    clearTimeout(this.timer);

    this.timer = setTimeout(() => {
      if (!this.elem) return;
      console.log('Long-press triggered on:', this.elem);
      this.blockClick = true;
      this.elem.classList.add('long-pressing');
      if (navigator.vibrate) navigator.vibrate(50);

      const b = this.elem.closest('.bubble');
      if (b && b.dataset.content) {
        console.log(`Long-press download: "${b.dataset.name}"`);
        setTimeout(() => {
          Utils.triggerDownload(b.dataset.content, b.dataset.name);
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
    const size = files.reduce((acc, f) => acc + f.size, 0);
    console.log(`Adding ${files.length} files. Total: ${Utils.formatSize(size)}`);
    for (const f of files) {
      this.totalBytes += f.size;
    }
    this.queue.push(...files);
    this.processNext();
  },

  processNext() {
    if (this.processing || !this.queue.length) {
      if (!this.queue.length && this.totalBytes > 0) {
        console.log('Upload queue finished.');
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
    const sizeStr = Utils.formatSize(file.size);
    console.log(`Processing "${file.name}" (${sizeStr})`);

    if (file.size > CONFIG.MAX_UPLOAD_SIZE) {
      const msg = `File "${file.name}" too large (${sizeStr}).`;
      console.error(msg);
      Toast.show(msg, 'error');
      this.processing = false;
      return this.processNext();
    }

    this.uploadFile(file)
      .then(res => {
        SocketManager.send(
          'file', res.url, file.name, file.type, file.size
        );
      })
      .catch(e => {
        Toast.show(e.message, 'error');
      })
      .finally(() => {
        this.loadedBytes += file.size;
        this.updateProgress(0);
        this.processing = false;
        this.processNext();
      });
  },

  updateProgress(inc) {
    if (this.totalBytes === 0) return;
    const cur = this.loadedBytes + inc;
    const pct = Math.min((cur / this.totalBytes) * 100, 100);
    UI.loader.classList.add('active');
    UI.loader.style.width = `${pct}%`;
  },

  uploadFile(file) {
    return new Promise((resolve, reject) => {
      const useDataURL = file.size <= 500 * 1024;
      console.log(`Upload "${file.name}": ${useDataURL ? 'Data URL' : 'XHR'}.`);

      if (useDataURL) {
        const r = new FileReader();
        r.onload = () => {
          console.log(`Read "${file.name}" as Data URL.`);
          resolve({ url: r.result });
        };
        r.onerror = (err) => {
          console.error(`FileReader error "${file.name}":`, err);
          reject(new Error(`Failed to read file: ${file.name}`));
        };
        r.readAsDataURL(file);
      } else {
        const xhr = new XMLHttpRequest();
        const fd = new FormData();
        fd.append('file', file);
        xhr.open('POST', '/upload');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) this.updateProgress(e.loaded);
        };
        xhr.onload = () => {
          if (xhr.status === 200) {
            const response = JSON.parse(xhr.responseText);
            console.log(`XHR upload success "${file.name}".`);
            resolve(response);
          } else {
            console.error(`XHR fail "${file.name}": ${xhr.status}`);
            reject(new Error(`Upload failed for ${file.name}`));
          }
        };
        xhr.onerror = () => {
          console.error(`XHR network error "${file.name}".`);
          reject(new Error('Network error during upload'));
        };
        xhr.send(fd);
      }
    });
  }
};

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

    console.log(`Locking orientation to "${vidOrient}" (Force: ${force})`);
    this.lockPromise = this.lockPromise.then(async () => {
      try {
        if (screen.orientation?.lock) {
          await screen.orientation.lock(vidOrient);
        }
      } catch (e) {
        console.warn('Orientation lock failed:', e);
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
        console.log('Auto-fullscreen triggered (landscape).');
        this.enterFullscreen('auto').catch((e) => {
          console.warn('Auto-fullscreen failed:', e);
        });
      }
    }
  },

  cleanup() {
    if (this._tempPdfUrl) {
      console.log('Revoking temp PDF URL.');
      URL.revokeObjectURL(this._tempPdfUrl);
      this._tempPdfUrl = null;
    }
  },

  close() {
    clearTimeout(this._clearTimer);
    const wasActive = UI.modal.classList.contains('active');
    if (!this.current && !wasActive) return;

    console.log('Closing preview.');
    if (this.mediaElement) {
      try { this.mediaElement.pause(); } catch (e) {}
    }

    this.abortController?.abort();
    if (this.abortController) console.log('Aborted pending fetch.');
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
    const { name, type, size, url } = this.current;
    console.log(`Copy content: "${name}" (${type})`);

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
        console.log('Copying image.');
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

            canvas.toBlob((pngBlob) => {
              if (pngBlob) resolve(pngBlob);
              else reject(new Error('Canvas toBlob failed'));
            }, 'image/png', 1.0);
          } catch (err) {
            reject(err);
          }
        });

        const item = new ClipboardItem({ 'image/png': pngPromise });
        await navigator.clipboard.write([item]);
      } else {
        console.log('Copying text.');
        const res = await fetch(url);
        const text = await res.text();
        await navigator.clipboard.writeText(text);
      }
      Tooltip.show(btn, 'Copied!');
    } catch (e) {
      console.error('Copy content failed:', e);
      Tooltip.show(btn, 'Failed', 'error');
    } finally {
      btn.innerHTML = oldHtml;
      btn.disabled = false;
    }
  },

  copyLink(btn) {
    if (!this.current) return;
    console.log(`Copy link: "${this.current.name}"`);
    if (this.current.url.startsWith('data:')) {
      return Tooltip.show(btn, 'No Link', 'error');
    }
    const u = new URL(this.current.url, location.origin).href;
    navigator.clipboard.writeText(u);
    Tooltip.show(btn, 'Copied!');
  },

  createCard(icon, name, label, actionBtn) {
    const card = document.createElement('div');
    card.className = 'preview-card';
    card.innerHTML = `
      <div class="card-content">
        <i class="fas ${icon} card-icon"></i>
        <div class="card-label"></div>
      </div>`;

    const lbl = card.querySelector('.card-label');
    lbl.textContent = name;
    lbl.title = name;

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
    console.log(`Download: "${this.current.name}"`);
    Utils.triggerDownload(this.current.url, this.current.name);
    Tooltip.show(btn, 'Started!');
  },

  async enterFullscreen(mode) {
    if (!this.mediaElement) return;
    console.log(`Enter fullscreen (${mode}).`);
    this.fullscreenMode = mode;
    try {
      if (this.mediaElement.requestFullscreen) {
        await this.mediaElement.requestFullscreen();
      } else if (this.mediaElement.webkitEnterFullscreen) {
        this.mediaElement.webkitEnterFullscreen();
      } else if (this.mediaElement.webkitRequestFullscreen) {
        await this.mediaElement.webkitRequestFullscreen();
      }
    } catch (e) {
      this.fullscreenMode = 'none';
      throw e;
    }
  },

  exitFullscreen() {
    try {
      const d = document;
      if (d.fullscreenElement || d.webkitFullscreenElement) {
        console.log('Exiting fullscreen.');
        if (d.exitFullscreen) {
          d.exitFullscreen().catch(e =>
            console.warn('exitFullscreen failed', e));
        } else if (d.webkitExitFullscreen) {
          d.webkitExitFullscreen();
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
      if (screen.orientation.type.includes('landscape'))
        return 'landscape';
      if (screen.orientation.type.includes('portrait'))
        return 'portrait';
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
    console.log('Fullscreen exit handler.');
    if (this.fullscreenMode === 'auto' &&
      this.getDeviceOrientation() === 'landscape') {
      console.log('Disabling auto-fullscreen (manual exit).');
      this.autoFullscreenAllowed = false;
    }
    this.fullscreenMode = 'none';
    this.unlockScreen();
  },

  init() {
    const allTooltipBtns = [...UI.copyContentBtns, ...UI.actionBtns];
    allTooltipBtns.forEach(b => {
      if (b) b.dataset.orig = b.getAttribute('data-tooltip') || '';
    });

    const bind = (btn, fn, name) => {
      if (!btn) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        console.log(`Action: ${name}`);
        fn(btn);
      });
    };

    UI.copyContentBtns.forEach(b =>
      bind(b, btn => this.copyContent(btn), 'copyContent'));

    const copyLink = b => this.copyLink(b);
    const dlLink = b => this.download(b);

    [0, 2].forEach(i => bind(UI.actionBtns[i], copyLink, 'copyLink'));
    [1, 3].forEach(i => bind(UI.actionBtns[i], dlLink, 'download'));

    UI.modalCloseBtn.onclick = () => this.close();
    UI.modal.onclick = (e) => {
      const isOut = e.target === UI.modal ||
        e.target.classList.contains('modal-overlay') ||
        e.target.classList.contains('modal-container') ||
        e.target.classList.contains('modal-content');
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
    console.log('PreviewManager initialized.');
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
    console.log(`FS change. Active: ${isFS}, Mode: ${this.fullscreenMode}`);
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

  open(url, type, name, size) {
    console.log(`Open preview: "${name}" (${type})`);
    this.close();
    this.current = { url, type, name, size };
    this.render();
  },

  async render() {
    if (!this.current) return;
    if (this.isInFullscreen()) return;

    this.cleanup();

    const isDesk = !this.isMobileLayout();
    const container = isDesk ? UI.previewStage : UI.modalContent;
    console.log(`Rendering (${isDesk ? 'Desktop' : 'Mobile'}).`);

    if (isDesk) UI.modal.classList.remove('active');
    else UI.modal.classList.add('active');

    const { type, url, name, size } = this.current;
    const isSafe = url.startsWith('/uploads/') ||
      url.startsWith('data:');

    if (this.mediaElement && this.mediaElement.dataset.src === url) {
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
    container.innerHTML = '<div class="loader-spinner">Loading...</div>';

    let node;
    const isMobilePdf = type === 'application/pdf' &&
      /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) &&
      !/Firefox/i.test(navigator.userAgent);

    if (size === 0) {
      node = this.createCard('fa-file-alt', 'File empty');
    } else if (!isSafe) {
      node = this.createCard('fa-shield-alt', 'Blocked');
    } else if (Utils.isWebSafe(type) && type.startsWith('image/')) {
      node = this.renderImage(url);
    } else if (Utils.isWebSafe(type) && type.startsWith('video/')) {
      node = this.renderVideo(url);
    } else if (type.startsWith('audio/')) {
      node = this.renderAudio(url);
    } else if (type === 'application/pdf') {
      node = this.renderPdf(url, name, isMobilePdf);
    } else if (type?.startsWith('text/') || type?.includes('json')) {
      node = await this.renderText(url, size);
    } else {
      node = this.renderCard(type, name, size);
    }

    container.innerHTML = '';
    const isFill = size > 0 &&
      ((type === 'application/pdf' && !isMobilePdf) ||
        ((type?.startsWith('text/') || type?.includes('json')) &&
          size <= CONFIG.TEXT_PREVIEW_LIMIT));

    node.classList.add(isDesk ? 'preview-item' : 'modal-preview-item');
    node.classList.add(isFill ? 'layout-fill' : 'layout-fit');
    container.appendChild(node);

    const canCopy = type?.match(
      /text|image|json|javascript|typescript|xml|svg/
    );
    UI.copyContentBtns.forEach(b => { if (b) b.disabled = !canCopy; });
    UI.actionBtns.forEach(b => { if (b) b.disabled = false; });
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
      Utils.getIcon(type), name, Utils.formatSize(size)
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
        'fa-file-pdf', name, 'Preview unavailable', link
      );
    }

    let displayUrl = url;
    if (url.startsWith('data:')) {
      console.log('Converting data URL to Blob for PDF.');
      try {
        const byteString = atob(url.split(',')[1]);
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteString.length; i++) {
          ia[i] = byteString.charCodeAt(i);
        }
        const blob = new Blob([ab], { type: 'application/pdf' });
        displayUrl = URL.createObjectURL(blob);
        this._tempPdfUrl = displayUrl;
      } catch (e) {
        console.error('PDF data URL conversion failed', e);
        return this.createCard(
          'fa-file-pdf', name, 'Error displaying PDF'
        );
      }
    }

    const node = document.createElement('iframe');
    node.src = displayUrl;
    node.className = 'media-content media-frame';
    node.setAttribute('sandbox', 'allow-scripts allow-popups');
    return node;
  },

  async renderText(url, size) {
    if (size > CONFIG.TEXT_PREVIEW_LIMIT) {
      console.warn(`Text too large (${Utils.formatSize(size)}).`);
      return this.createCard('fa-file-alt', 'File too large');
    }
    const pre = document.createElement('pre');
    pre.className = 'text-preview';
    try {
      if (url.startsWith('data:')) {
        const b64 = url.split(',')[1];
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
          bytes[i] = bin.charCodeAt(i);
        }
        pre.textContent = new TextDecoder().decode(bytes);
      } else {
        const res = await fetch(url, {
          signal: this.abortController.signal
        });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        pre.textContent = await res.text();
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        console.log('Text preview fetch aborted.');
      } else {
        console.error('Error loading text preview:', e);
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
        const dev = this.getDeviceOrientation();
        const vid = this.getVideoOrientation();
        if (dev === 'landscape' && vid === 'landscape') {
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
      console.error('Video element error:', node.error);
    });

    this.mediaElement = node;
    return node;
  },

  unlockScreen() {
    try {
      if (screen.orientation?.unlock) {
        console.log('Unlocking screen orientation.');
        screen.orientation.unlock();
      }
    } catch (e) {
      console.warn('Screen unlock failed:', e);
    }
  }
};

const MediaPreloader = {
  load(msg) {
    return new Promise((resolve) => {
      const type = msg.fileType || '';
      if (!type.startsWith('image/') &&
        !type.startsWith('video/')) {
        return resolve(null);
      }
      if (!Utils.isWebSafe(type)) {
        console.log(`Skipping unsafe preload: ${type}`);
        return resolve(null);
      }
      console.log(`Preloading: "${msg.name}"`);

      if (type.startsWith('video/')) {
        const vid = document.createElement('video');
        vid.muted = true;
        vid.playsInline = true;
        vid.preload = 'auto';
        vid.className = 'embed-media';
        vid.src = msg.content;

        const finish = (result) => {
          vid.onloadeddata = null;
          vid.onerror = null;
          clearTimeout(tm);
          resolve(result);
        };

        const tm = setTimeout(() => {
          console.warn(`Preload timeout: "${msg.name}"`);
          finish(null);
        }, 5000);
        vid.onloadeddata = () => {
          console.log(`Video preloaded: "${msg.name}"`);
          finish(vid);
        };
        vid.onerror = () => {
          console.error(`Preload error: "${msg.name}"`);
          finish(null);
        };
        return;
      }

      if (type.startsWith('image/')) {
        const img = new Image();
        img.className = 'embed-media';
        img.src = msg.content;

        const finish = (result) => {
          img.onload = null;
          img.onerror = null;
          clearTimeout(tm);
          resolve(result);
        };

        const tm = setTimeout(() => {
          console.warn(`Preload timeout: "${msg.name}"`);
          finish(null);
        }, 5000);
        img.onload = () => {
          console.log(`Image preloaded: "${msg.name}"`);
          finish(img);
        };
        img.onerror = () => {
          console.error(`Preload error: "${msg.name}"`);
          finish(null);
        };
        return;
      }

      resolve(null);
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
    const m = msg.fileType || '';
    if ((m.startsWith('image/') || m.startsWith('video/')) &&
      Utils.isWebSafe(m)) {
      return 'media';
    }
    return 'file';
  },

  prune() {
    const MAX_CNT = 1000;
    const MAX_MEM = 256 * 1024 * 1024;
    const startCount = this.domCount;
    const startSize = this.domSize;
    while (this.domCount > MAX_CNT || this.domSize > MAX_MEM) {
      const top = UI.messageList.firstElementChild;
      if (!top) break;
      if (top.classList.contains('message-group')) {
        const b = top.querySelector('.bubble');
        if (b) {
          this.domSize -= parseInt(b.dataset.memSize || 0);
          this.domCount--;
          b.remove();
        }
        if (!top.querySelector('.bubble')) top.remove();
      } else {
        top.remove();
      }
    }
    if (this.domCount < startCount) {
      console.log(
        `Pruned DOM. Freed: ${Utils.formatSize(startSize - this.domSize)}.`
      );
    }
  },

  render(msg, preloadedNode = null) {
    const isMe = msg.senderId === socket.id;
    const time = msg.timestamp || Date.now();
    const cat = this.getCat(msg);

    if (!msg.isPending && msg.tempId) {
      const p = document.getElementById(msg.tempId);
      if (p) {
        console.log(`Updating pending msg: ${msg.tempId}`);
        p.classList.remove('pending');
        p.removeAttribute('id');
        if (msg.fileType) p.dataset.type = msg.fileType;
        if (msg.size) p.dataset.size = msg.size;
        if (msg.name) p.dataset.name = msg.name;
        const s = p.querySelector('.file-size');
        if (s) s.textContent = Utils.formatSize(msg.size);
        return;
      }
    }

    if (!msg.isPending && isMe &&
      document.getElementById(msg.tempId)) {
      console.warn(`Duplicate render ${msg.tempId}. Ignoring.`);
      return;
    }

    const isNew = this.lastId !== msg.senderId ||
      time - this.lastTime > 60000 ||
      this.lastCat !== cat;

    if (isNew) {
      const grp = document.createElement('div');
      grp.className = `message-group ${isMe ? 'me' : 'them'}`;
      const hue = msg.hue ?? 0;
      grp.style.setProperty('--user-color', `hsl(${hue}, 50%, 50%)`);

      const ts = document.createElement('div');
      ts.className = 'group-timestamp';
      ts.textContent = Utils.formatTime(time);
      grp.appendChild(ts);
      UI.messageList.appendChild(grp);
      this.lastId = msg.senderId;
      this.lastTime = time;
    }

    const grp = UI.messageList.lastElementChild;
    const b = document.createElement('div');
    b.className = `bubble ${msg.isPending ? 'pending' : ''}`;
    if (msg.tempId) b.id = msg.tempId;

    if (msg.type === 'text') {
      const t = document.createElement('div');
      t.className = 'bubble-text';
      t.appendChild(Utils.linkify(msg.content));
      b.appendChild(t);
    } else {
      const m = msg.fileType || 'application/octet-stream';
      const isEmb = (m.startsWith('image/') ||
        m.startsWith('video/')) && Utils.isWebSafe(m);
      const isAudio = m.startsWith('audio/');

      b.dataset.content = msg.content;
      b.dataset.type = m;
      b.dataset.name = msg.name;
      b.dataset.size = msg.size;

      const open = () => {
        PreviewManager.open(
          b.dataset.content,
          b.dataset.type,
          b.dataset.name,
          parseInt(b.dataset.size)
        );
      };

      if (isAudio) {
        b.classList.add('file-bubble');
        const player = AudioFactory.create(msg.content, msg.name);
        b.appendChild(player);
      } else if (isEmb) {
        b.classList.add('embed-bubble');
        const w = document.createElement('div');
        w.className = 'bubble-embed-container';
        w.onclick = open;

        if (preloadedNode) {
          if (preloadedNode.tagName === 'VIDEO') {
            const ratio = preloadedNode.videoWidth /
              preloadedNode.videoHeight;
            if (ratio && isFinite(ratio)) {
              w.style.aspectRatio = String(ratio);
            }
          } else if (preloadedNode.tagName === 'IMG') {
            const ratio = preloadedNode.naturalWidth /
              preloadedNode.naturalHeight;
            if (ratio && isFinite(ratio)) {
              w.style.aspectRatio = String(ratio);
            }
          }
          w.appendChild(preloadedNode);
          if (preloadedNode.tagName === 'VIDEO') {
            const o = document.createElement('div');
            o.className = 'play-icon-overlay';
            o.innerHTML = '<i class="fas fa-play"></i>';
            w.appendChild(o);
          }
        } else {
          if (m.startsWith('video')) {
            const med = document.createElement('video');
            med.className = 'embed-media';
            med.muted = true;
            med.playsInline = true;
            med.preload = 'metadata';
            med.src = msg.content;
            med.onloadeddata = () => { med.currentTime = 0.001; };
            w.appendChild(med);

            const o = document.createElement('div');
            o.className = 'play-icon-overlay';
            o.innerHTML = '<i class="fas fa-play"></i>';
            w.appendChild(o);
          } else {
            const med = document.createElement('img');
            med.className = 'embed-media';
            med.src = msg.content;
            w.appendChild(med);
          }
        }
        b.appendChild(w);
      } else {
        b.classList.add('file-bubble');
        const c = document.createElement('div');
        c.className = 'file-card';
        c.onclick = open;
        const icon = Utils.getIcon(m);
        c.innerHTML = `
          <div class="file-icon-wrapper">
            <i class="fas ${icon}"></i>
          </div>
          <div class="file-meta">
            <span class="file-name"></span>
            <span class="file-size"></span>
          </div>`;
        c.querySelector('.file-name').textContent = msg.name;
        const sizeText = msg.isPending
          ? 'Uploading...'
          : Utils.formatSize(msg.size);
        c.querySelector('.file-size').textContent = sizeText;
        b.appendChild(c);
      }
    }

    const mem = (msg.content || '').length;
    b.dataset.memSize = mem;
    this.domSize += mem;
    this.domCount++;

    grp.insertBefore(b, grp.lastElementChild);
    this.prune();

    this.lastCat = cat;
    this.scrollToBottom();
  },

  reset() {
    console.log('Resetting renderer.');
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
    console.log(`Enqueue msg. Queue size: ${this.queue.length + 1}`);
    this.queue.push(msg);
    this.process();
  },

  async process() {
    if (this.active) return;
    this.active = true;

    while (this.queue.length) {
      const msg = this.queue[0];

      if (!msg.isPending && msg.tempId) {
        const el = document.getElementById(msg.tempId);
        if (el) {
          MessageRenderer.render(msg);
          this.queue.shift();
          continue;
        }
      }

      let node = null;
      try {
        node = await MediaPreloader.load(msg);
      } catch (e) {
        console.error('Media preloader failed:', e);
      }

      MessageRenderer.render(msg, node);
      this.queue.shift();
    }

    this.active = false;
  }
};

const SocketManager = {
  send(type, content, name, fileType, size) {
    const tid = `t-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const payload = {
      type, content, name, fileType, size, tempId: tid, hue: myHue
    };

    let logContent;
    if (type === 'text') {
      logContent = content.length > 200
        ? content.substring(0, 200) + '...'
        : content;
    } else if (type === 'file' && typeof content === 'string' &&
      content.startsWith('data:')) {
      logContent = `Data URL (${fileType}, ${Utils.formatSize(size)})`;
    } else {
      logContent = content;
    }
    console.log(`Send msg (${type}): "${logContent}"`);

    MessageQueue.enqueue({
      ...payload,
      senderId: socket.id,
      timestamp: Date.now(),
      isPending: true
    });
    socket.emit('message', payload);
  }
};

socket.on('session', (data) => {
  myHue = data.hue;
  console.log('Session hue:', myHue);
  UI.sendBtn.style.backgroundColor = `hsl(${myHue}, 50%, 50%)`;
  UI.sendBtn.style.color = 'white';
});

socket.on('userCountUpdate', (c) => {
  console.log('User count:', c);
  UI.userCount.textContent = c;
});
socket.on('message', (m) => {
  console.log('Received message:', m);
  MessageQueue.enqueue(m);
});
socket.on('error', (e) => {
  console.error('Server error:', e);
  Toast.show(e.message || e, 'error');
});

PreviewManager.init();
TouchDelegate.init();

UI.input.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    UI.sendBtn.click();
  }
};

UI.input.oninput = function() {
  const oldHeight = this.style.height;
  this.style.height = 'auto';
  const newHeight = Math.min(this.scrollHeight, 120);
  this.style.height = newHeight + 'px';
  if (oldHeight !== this.style.height) {
    console.log(`Input resize: ${newHeight}px`);
  }
};

UI.sendBtn.onclick = () => {
  const t = UI.input.value.trim();
  if (!t) return;
  SocketManager.send('text', t);
  UI.input.value = '';
  UI.input.style.height = 'auto';
  UI.input.focus();
};

UI.fileInput.onchange = function() {
  if (this.files.length) {
    console.log(`File input: ${this.files.length} selected.`);
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
      this.btn.onclick = (e) => {
        e.preventDefault();
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

    const elapsed = Date.now() - start;
    const remaining = minTime - elapsed;

    if (remaining > 0) {
      await new Promise(r => setTimeout(r, remaining));
    }

    await this.waitForSpinLoop();

    this.btn.classList.remove('spinning');
    this.container.classList.remove('armed');
    UI.messageList.classList.remove('destructing');

    Toast.show('Chat cleared locally');
  },

  waitForSpinLoop() {
    return new Promise(resolve => {
      if (getComputedStyle(this.icon).animationName === 'none') return resolve();

      const handler = () => {
        this.icon.removeEventListener('animationiteration', handler);
        resolve();
      };
      this.icon.addEventListener('animationiteration', handler, { once: true });
    });
  }
};

ResetController.init();

let dragCounter = 0;
const isFiles = (e) => e.dataTransfer.types.includes('Files');

window.ondragenter = (e) => {
  if (isFiles(e)) {
    e.preventDefault();
    dragCounter++;
    UI.dropOverlay.classList.add('active');
  }
};
window.ondragleave = (e) => {
  if (isFiles(e)) {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
      UI.dropOverlay.classList.remove('active');
    }
  }
};
window.ondragover = (e) => {
  if (isFiles(e)) e.preventDefault();
};
window.ondrop = (e) => {
  if (isFiles(e)) {
    e.preventDefault();
    dragCounter = 0;
    UI.dropOverlay.classList.remove('active');
    if (e.dataTransfer.files.length) {
      console.log(`Dropped ${e.dataTransfer.files.length} files.`);
      UploadManager.add(Array.from(e.dataTransfer.files));
    }
  }
};
window.onpaste = (e) => {
  const items = Array.from(e.clipboardData.items);
  const files = items.filter(i => i.kind === 'file')
    .map(i => i.getAsFile());
  if (files.length) {
    console.log(`Pasted ${files.length} files.`);
    UploadManager.add(files);
  }
};

if (UI.resizer) {
  let drag = false;
  UI.resizer.onmousedown = () => {
    drag = true;
    UI.resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
  };
  document.onmousemove = (e) => {
    const min = 320;
    const max = innerWidth - min;
    if (drag && e.clientX >= min && e.clientX <= max) {
      document.querySelector('.app-layout')
        .style.setProperty('--left-pane-width', `${e.clientX}px`);
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
console.log('App initialized.');
document.body.style.opacity = '1';
UI.input.focus();
