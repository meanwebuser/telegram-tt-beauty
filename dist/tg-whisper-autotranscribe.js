(() => {
  'use strict';

  const CACHE_PREFIX = 'tg-whisper-transcript:v1:';
  const IN_FLIGHT = new Set();
  const ENDPOINT = '/proxy/whisper-v1/audio/transcriptions';

  function injectStyle() {
    if (document.getElementById('tg-whisper-autotranscribe-style')) return;
    const style = document.createElement('style');
    style.id = 'tg-whisper-autotranscribe-style';
    style.textContent = `
      .tg-whisper-transcription {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        margin: .375rem .25rem .125rem;
        line-height: 1.35;
      }
      .tg-whisper-transcription.is-pending { opacity: .72; font-style: italic; }
      .tg-whisper-transcription.is-error { color: var(--color-error, #df3f40); }
    `;
    document.head.appendChild(style);
  }

  function getMessageId(message) {
    return message && (message.id ?? message.messageId);
  }

  function getCacheKey(message) {
    const chatId = message?.chatId ?? 'unknown-chat';
    const messageId = getMessageId(message) ?? 'unknown-message';
    return `${CACHE_PREFIX}${chatId}:${messageId}`;
  }

  function getCachedText(message) {
    try {
      return localStorage.getItem(getCacheKey(message));
    } catch {
      return null;
    }
  }

  function setCachedText(message, text) {
    try {
      localStorage.setItem(getCacheKey(message), text);
    } catch {
      // Local cache is best-effort. The UI should still show the transcript.
    }
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function findMessageElement(message) {
    const id = getMessageId(message);
    if (id === undefined || id === null) return null;
    const selector = `[data-message-id="${cssEscape(id)}"]`;
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      const messageNode = node.classList?.contains('Message') ? node : node.closest?.('.Message');
      if (messageNode && messageNode.querySelector('.Audio, .RoundVideo, .media-inner, .content')) return messageNode;
    }
    return nodes[0]?.closest?.('.Message') || nodes[0] || null;
  }

  function ensureTranscriptElement(message) {
    injectStyle();
    const root = findMessageElement(message);
    if (!root) return null;

    let el = root.querySelector('.tg-whisper-transcription');
    if (el) return el;

    el = document.createElement('p');
    el.className = 'transcription tg-whisper-transcription';
    el.dir = 'auto';

    const anchor = root.querySelector('.Audio.inline, .Audio, .RoundVideo, .media-inner, .content');
    if (anchor?.parentNode) {
      anchor.parentNode.insertBefore(el, anchor.nextSibling);
    } else {
      root.appendChild(el);
    }
    return el;
  }

  function renderTranscript(message, text, state = 'ready') {
    const el = ensureTranscriptElement(message);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-pending', state === 'pending');
    el.classList.toggle('is-error', state === 'error');
  }


  function isProgressiveUrl(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && (url.pathname.startsWith('/progressive/') || url.pathname.startsWith('/download/'));
    } catch {
      return false;
    }
  }

  function parseContentRange(value) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim());
    if (!match) return null;
    return {
      start: Number(match[1]),
      end: Number(match[2]),
      fullSize: match[3] === '*' ? undefined : Number(match[3]),
    };
  }

  async function fetchProgressiveBlob(url) {
    const chunks = [];
    let start = 0;
    let fullSize;
    let type = '';
    const partSize = 512 * 1024;

    for (let part = 0; part < 512; part += 1) {
      const end = start + partSize - 1;
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!(response.status === 206 || response.ok)) {
        throw new Error(`cannot read progressive media part: ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType) type = contentType;
      if (contentType.toLowerCase().startsWith('text/html')) {
        throw new Error('progressive media returned HTML instead of audio');
      }

      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength) break;
      chunks.push(buffer);

      const range = parseContentRange(response.headers.get('content-range'));
      if (range?.fullSize !== undefined) fullSize = range.fullSize;
      if (range) {
        start = range.end + 1;
      } else {
        start += buffer.byteLength;
      }

      if (fullSize !== undefined && start >= fullSize) break;
      if (buffer.byteLength < partSize && fullSize === undefined) break;
    }

    if (!chunks.length) throw new Error('progressive media returned empty data');
    return new Blob(chunks, { type });
  }

  async function mediaDataToBlob(mediaData) {
    if (!mediaData) throw new Error('voice audio is not loaded yet');
    if (mediaData instanceof Blob) return mediaData;
    if (mediaData instanceof ArrayBuffer) return new Blob([mediaData]);
    if (ArrayBuffer.isView(mediaData)) return new Blob([mediaData.buffer]);

    if (typeof mediaData === 'string') {
      if (isProgressiveUrl(mediaData)) return fetchProgressiveBlob(mediaData);
      const response = await fetch(mediaData, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(`cannot read media blob: ${response.status}`);
      return response.blob();
    }

    if (typeof mediaData === 'object') {
      const directBlob = mediaData.blob || mediaData.file;
      if (directBlob instanceof Blob) return directBlob;

      const bytes = mediaData.bytes || mediaData.data || mediaData.buffer;
      if (bytes instanceof ArrayBuffer) return new Blob([bytes], { type: mediaData.mimeType || mediaData.type || '' });
      if (ArrayBuffer.isView(bytes)) return new Blob([bytes.buffer], { type: mediaData.mimeType || mediaData.type || '' });

      const url = mediaData.url || mediaData.src || mediaData.blobUrl || mediaData.objectUrl;
      if (typeof url === 'string') {
        if (isProgressiveUrl(url)) return fetchProgressiveBlob(url);
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error(`cannot read media url: ${response.status}`);
        return response.blob();
      }
    }

    throw new Error('unsupported media data format');
  }


  function makeSkipError(message) {
    const err = new Error(message);
    err.code = 'TG_WHISPER_SKIP';
    return err;
  }

  async function getBlobHeader(blob, length = 64) {
    const slice = blob.slice(0, Math.min(length, blob.size));
    return new Uint8Array(await slice.arrayBuffer());
  }

  function asciiAt(bytes, offset, text) {
    if (bytes.length < offset + text.length) return false;
    for (let i = 0; i < text.length; i += 1) {
      if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  }

  function hasSupportedAudioVideoSignature(bytes) {
    return asciiAt(bytes, 0, 'OggS')
      || asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE')
      || asciiAt(bytes, 0, 'ID3')
      || asciiAt(bytes, 0, 'fLaC')
      || asciiAt(bytes, 4, 'ftyp')
      || (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3);
  }

  function isSupportedMime(type) {
    const mime = String(type || '').toLowerCase();
    return !mime
      || mime.startsWith('audio/')
      || mime.startsWith('video/')
      || mime === 'application/octet-stream'
      || mime === 'binary/octet-stream';
  }


  function canValidatePlayback() {
    return typeof URL !== 'undefined' && typeof document !== 'undefined';
  }

  async function assertBrowserCanLoadMedia(blob, options = {}) {
    if (!options.silent || !canValidatePlayback()) return;

    await new Promise((resolve, reject) => {
      const el = document.createElement(String(blob.type || '').toLowerCase().startsWith('video/') ? 'video' : 'audio');
      const url = URL.createObjectURL(blob);
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        el.removeAttribute('src');
        try { el.load(); } catch {}
        URL.revokeObjectURL(url);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(makeSkipError('browser could not read media metadata in time')), 2500);
      el.preload = 'metadata';
      el.onloadedmetadata = () => {
        const duration = Number(el.duration);
        if (Number.isFinite(duration) && duration > 0) finish();
        else finish(makeSkipError(`browser loaded empty media duration: ${el.duration}`));
      };
      el.onerror = () => finish(makeSkipError('browser rejected media blob before transcription'));
      el.src = url;
      try { el.load(); } catch (err) { finish(makeSkipError(`browser media load failed: ${err?.message || err}`)); }
    });
  }

  async function normalizeAudioBlob(blob, message, options = {}) {
    if (!(blob instanceof Blob)) throw new Error('loaded media is not a Blob');
    if (blob.size < 1024) throw makeSkipError(`media blob is too small: ${blob.size} bytes`);
    if (!isSupportedMime(blob.type)) throw makeSkipError(`unsupported media MIME type: ${blob.type}`);

    const header = await getBlobHeader(blob);
    if (!hasSupportedAudioVideoSignature(header)) {
      const prefix = Array.from(header.slice(0, 12)).map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
      throw makeSkipError(`unsupported media container: ${prefix}`);
    }

    await assertBrowserCanLoadMedia(blob, options);
    return blob;
  }

  function filenameFor(message, blob) {
    const type = blob.type || 'audio/ogg';
    const ext = type.includes('webm') ? 'webm'
      : type.includes('mpeg') || type.includes('mp3') ? 'mp3'
        : type.includes('wav') ? 'wav'
          : type.includes('mp4') ? 'm4a'
            : 'ogg';
    return `telegram-${message?.chatId || 'chat'}-${getMessageId(message) || Date.now()}.${ext}`;
  }


  async function assertNotHtmlBlob(blob) {
    const type = String(blob?.type || '').toLowerCase();
    if (type.startsWith('text/html')) {
      throw makeSkipError('refusing to transcribe HTML response instead of media');
    }
    try {
      const head = await blob.slice(0, 128).text();
      if (/^\s*<!doctype\s+html/i.test(head) || /^\s*<html[\s>]/i.test(head)) {
        throw makeSkipError('refusing to transcribe HTML document instead of media');
      }
    } catch (err) {
      if (err?.code === 'TG_WHISPER_SKIP') throw err;
    }
  }

  async function transcribe(mediaData, message, options = {}) {
    const messageId = getMessageId(message);
    if (messageId === undefined || messageId === null) return true;

    const key = getCacheKey(message);
    const cached = getCachedText(message);
    if (cached) {
      renderTranscript(message, cached);
      return true;
    }

    if (IN_FLIGHT.has(key)) return true;
    IN_FLIGHT.add(key);

    try {
      const rawBlob = await mediaDataToBlob(mediaData);
      await assertNotHtmlBlob(rawBlob);
      const blob = await normalizeAudioBlob(rawBlob, message, options);
      await assertNotHtmlBlob(blob);
      renderTranscript(message, 'Транскрибирую…', 'pending');
      const form = new FormData();
      form.append('model', 'whisper-1');
      form.append('response_format', 'json');
      form.append('file', blob, filenameFor(message, blob));

      const response = await fetch(ENDPOINT, {
        method: 'POST',
        body: form,
        credentials: 'same-origin',
      });

      const raw = await response.text();
      let parsed;
      try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { text: raw }; }

      if (!response.ok) {
        const detail = parsed?.detail?.error?.message || parsed?.detail || parsed?.error?.message || parsed?.error || raw || response.statusText;
        const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail);
        if (options.silent && /Invalid data found|InvalidDataError|unsupported media|could not read media|ffmpeg|av\.error/i.test(detailText)) {
          throw makeSkipError(detailText);
        }
        throw new Error(detailText);
      }

      const text = (parsed?.text || parsed?.transcription || parsed?.result || '').trim();
      if (!text) throw new Error('Whisper вернул пустой текст');

      setCachedText(message, text);
      renderTranscript(message, text);
    } catch (err) {
      if (err?.code === 'TG_WHISPER_SKIP' && options.silent) {
        console.debug('[tg-whisper] skipped unsupported media blob', err.message);
        return true;
      }
      console.error('[tg-whisper] transcription failed', err);
      renderTranscript(message, `Не удалось транскрибировать: ${err?.message || err}`, 'error');
    } finally {
      IN_FLIGHT.delete(key);
    }

    return true;
  }

  window.__tgWhisperTranscribeMedia = (mediaData, message) => transcribe(mediaData, message, { silent: false });
  window.__tgWhisperQueueMedia = (mediaData, message) => transcribe(mediaData, message, { silent: true });
  window.__tgWhisperTranscriptCache = {
    clear() {
      Object.keys(localStorage)
        .filter((key) => key.startsWith(CACHE_PREFIX))
        .forEach((key) => localStorage.removeItem(key));
    },
  };
})();
