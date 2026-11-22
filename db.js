/**
 * db.js - Motor Offline-First Transaccional para MeloAudible PWA
 * - Fuente de verdad síncrona inmediata en localStorage (0ms latencia, 0 condiciones de carrera)
 * - Respaldo serializado en IndexedDB para libros, MP3s, textos en español (.es.txt) y progreso
 * - Cola Sync Outbox para sincronizar automáticamente cambios hechos sin internet al reconectar
 * - Soporte de Marcadores de Audio (Bookmarks) e Historial Diario de Escucha
 */
const DB_NAME = 'MeloAudiolibrosOfflineDB';
const DB_VERSION = 1;
const MIRROR_STORAGE_KEY = 'melo_playback_mirror_v2';
const OUTBOX_STORAGE_KEY = 'melo_sync_outbox_v1';
const ACTIVITY_LOG_KEY = 'melo_listening_log_v1';

class OfflineAudioDB {
  constructor() {
    this.dbPromise = null;
    this._idbWriteChain = Promise.resolve();
  }

  open() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('chapters_audio')) {
          const store = db.createObjectStore('chapters_audio', { keyPath: 'key' });
          store.createIndex('by_book', 'book_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('playback')) {
          db.createObjectStore('playback', { keyPath: 'book_id' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return this.dbPromise;
  }

  async requestPersistentStorage() {
    if (navigator.storage && navigator.storage.persist) {
      try {
        return await navigator.storage.persist();
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  async getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        return {
          usageMB: Math.round((est.usage || 0) / (1024 * 1024)),
          quotaMB: Math.round((est.quota || 0) / (1024 * 1024)),
        };
      } catch (_) {}
    }
    return { usageMB: 0, quotaMB: 0 };
  }

  // --- LIBROS GUARDADOS OFFLINE ---
  async saveBookMetadata(book, coverDataUrl = null) {
    const db = await this.open();
    const existing = await this.getBookMetadata(book.id);
    const toSave = {
      ...(existing || {}),
      ...book,
      cover_data_url: coverDataUrl || (existing ? existing.cover_data_url : null),
      saved_offline_at: Date.now(),
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction('books', 'readwrite');
      tx.objectStore('books').put(toSave);
      tx.oncomplete = () => resolve(toSave);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async getBookMetadata(bookId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('books', 'readonly');
      const req = tx.objectStore('books').get(bookId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getAllOfflineBooks() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('books', 'readonly');
      const req = tx.objectStore('books').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // --- AUDIO Y TEXTO EN ESPAÑOL DE CAPÍTULOS OFFLINE ---
  chapterKey(bookId, chapterId) {
    return `${bookId}__cap_${chapterId}`;
  }

  async saveChapterAudio(bookId, chapterMeta, mp3Blob, textEs = null) {
    const db = await this.open();
    const existing = await this.getChapterAudio(bookId, chapterMeta.id);
    const record = {
      key: this.chapterKey(bookId, chapterMeta.id),
      book_id: bookId,
      chapter_id: chapterMeta.id,
      title_es: chapterMeta.title_es,
      title_en: chapterMeta.title_en,
      duration_min: chapterMeta.actual_min || chapterMeta.duration_min || 0,
      audio_mtime: chapterMeta.audio_mtime || 0,
      size_bytes: mp3Blob.size,
      blob: mp3Blob,
      text_es: textEs || (existing && existing.text_es) || chapterMeta.preview_es || '',
      downloaded_at: Date.now(),
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chapters_audio', 'readwrite');
      tx.objectStore('chapters_audio').put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async getChapterAudio(bookId, chapterId) {
    const db = await this.open();
    const key = this.chapterKey(bookId, chapterId);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chapters_audio', 'readonly');
      const req = tx.objectStore('chapters_audio').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getDownloadedChapterIdsForBook(bookId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chapters_audio', 'readonly');
      const index = tx.objectStore('chapters_audio').index('by_book');
      const req = index.getAllKeys(IDBKeyRange.only(bookId));
      req.onsuccess = () => {
        const keys = req.result || [];
        const ids = keys.map((k) => {
          const parts = String(k).split('__cap_');
          return parseInt(parts[1], 10);
        });
        resolve(new Set(ids));
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getAllDownloadedStats() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chapters_audio', 'readonly');
      const store = tx.objectStore('chapters_audio');
      const req = store.openCursor();
      const byBook = {};
      let totalBytes = 0;

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const val = cursor.value;
          if (!byBook[val.book_id]) {
            byBook[val.book_id] = { chapters: new Set(), bytes: 0 };
          }
          byBook[val.book_id].chapters.add(val.chapter_id);
          byBook[val.book_id].bytes += val.size_bytes || 0;
          totalBytes += val.size_bytes || 0;
          cursor.continue();
        } else {
          resolve({ byBook, totalBytes });
        }
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async deleteChapterAudio(bookId, chapterId) {
    const db = await this.open();
    const key = this.chapterKey(bookId, chapterId);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chapters_audio', 'readwrite');
      tx.objectStore('chapters_audio').delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async deleteCompletedBookAudio(bookId, completedChapterIds) {
    const db = await this.open();
    const downloadedIds = await this.getDownloadedChapterIdsForBook(bookId);
    const toDelete = [];
    for (const chId of completedChapterIds) {
      if (downloadedIds.has(Number(chId))) {
        toDelete.push(Number(chId));
      }
    }
    if (toDelete.length === 0) return { deletedCount: 0, freedBytes: 0 };

    let freedBytes = 0;
    for (const chId of toDelete) {
      const rec = await this.getChapterAudio(bookId, chId);
      if (rec && rec.size_bytes) freedBytes += rec.size_bytes;
    }

    await new Promise((resolve, reject) => {
      const tx = db.transaction('chapters_audio', 'readwrite');
      const audioStore = tx.objectStore('chapters_audio');
      toDelete.forEach((chId) => {
        audioStore.delete(this.chapterKey(bookId, chId));
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
    return { deletedCount: toDelete.length, freedBytes };
  }

  async deleteAllBookAudio(bookId) {
    const db = await this.open();
    const ids = await this.getDownloadedChapterIdsForBook(bookId);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['chapters_audio', 'books'], 'readwrite');
      const audioStore = tx.objectStore('chapters_audio');
      ids.forEach((chId) => {
        audioStore.delete(this.chapterKey(bookId, chId));
      });
      tx.objectStore('books').delete(bookId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // --- COLA OUTBOX DE SINCRONIZACIÓN OFFLINE ---
  _readOutbox() {
    try {
      const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  markBookDirtySync(bookId, ts = Date.now()) {
    try {
      const box = this._readOutbox();
      box[bookId] = Math.max(Number(box[bookId] || 0), ts);
      localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(box));
    } catch (_) {}
  }

  clearBookDirtySync(bookId, syncedUpToTs) {
    try {
      const box = this._readOutbox();
      if (box[bookId] && Number(box[bookId]) <= Number(syncedUpToTs || Date.now())) {
        delete box[bookId];
        localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(box));
      }
    } catch (_) {}
  }

  getPendingOutboxCountSync() {
    return Object.keys(this._readOutbox()).length;
  }

  getDirtyBooksPayloadSync() {
    const box = this._readOutbox();
    const mirror = this._readMirrorMap();
    const dirtyBooks = {};
    let maxTs = 0;
    for (const bId of Object.keys(box)) {
      if (mirror[bId]) {
        dirtyBooks[bId] = mirror[bId];
        maxTs = Math.max(maxTs, Number(box[bId] || 0), Number(mirror[bId].updated_at || 0));
      }
    }
    return { dirtyBooks, maxTs, count: Object.keys(dirtyBooks).length };
  }

  // --- PROGRESO TRANSACCIONAL SIN CONDICIONES DE CARRERA ---
  _readMirrorMap() {
    try {
      const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  getAllPlaybackStatesSync() {
    return this._readMirrorMap();
  }

  _writeMirrorItemSync(bookId, record, markDirty = true) {
    try {
      const map = this._readMirrorMap();
      const prev = map[bookId];
      // Protección estricta contra escritura fuera de orden: nunca retroceder updated_at salvo reset_pass explícito
      if (prev && !record.reset_pass && Number(record.updated_at || 0) < Number(prev.updated_at || 0)) {
        return prev;
      }
      map[bookId] = record;
      localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(map));
      if (markDirty) {
        this.markBookDirtySync(bookId, record.updated_at || Date.now());
      }
    } catch (_) {}
    return record;
  }

  _enqueueIdbBackup(bookId, recordSnapshot) {
    // Cola secuencial de escritura a IndexedDB que NUNCA pisa localStorage hacia atrás
    const copy = JSON.parse(JSON.stringify(recordSnapshot));
    this._idbWriteChain = this._idbWriteChain
      .then(async () => {
        const db = await this.open();
        await new Promise((resolve) => {
          const tx = db.transaction('playback', 'readwrite');
          const store = tx.objectStore('playback');
          const getReq = store.get(bookId);
          getReq.onsuccess = () => {
            const existing = getReq.result;
            if (!existing || copy.reset_pass || Number(copy.updated_at || 0) >= Number(existing.updated_at || 0)) {
              store.put(copy);
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      })
      .catch(() => {});
    return this._idbWriteChain;
  }

  _defaultBookRecord(bookId, chapterId = 1, playbackRate = 1.0, now = Date.now()) {
    return {
      book_id: bookId,
      chapter_id: chapterId,
      position_sec: 0,
      duration_sec: 0,
      playback_rate: playbackRate,
      times_completed: 0,
      relisten_pass: 1,
      pass_started_at: 0,
      last_paused_at: 0,
      bookmarks: [],
      updated_at: now,
      chapters: {},
    };
  }

  savePlaybackMirrorSync(
    bookId,
    chapterId,
    positionSec,
    durationSec = 0,
    playbackRate = 1.0,
    completed = false,
    options = {}
  ) {
    const now = Date.now();
    const map = this._readMirrorMap();
    const current = map[bookId] || this._defaultBookRecord(bookId, chapterId, playbackRate, now);
    const chKey = String(chapterId);
    const prevCh = (current.chapters && current.chapters[chKey]) || {};
    const safePos = Math.max(0, Number(positionSec) || 0);
    const safeDur = Number(durationSec) || Number(prevCh.duration_sec) || 0;

    // Auto-marcar como completado si superó el 92% del capítulo o le quedan menos de 40s (en capítulos >= 90s)
    const reachedEndThreshold =
      safeDur > 0 && (safePos / safeDur >= 0.92 || (safeDur >= 90 && safeDur - safePos <= 40));

    let isDone = false;
    if (options && options.explicit_toggle !== undefined) {
      isDone = Boolean(options.explicit_toggle);
    } else {
      isDone = Boolean(completed || prevCh.completed || reachedEndThreshold);
    }

    const nextPlayCount =
      completed || (reachedEndThreshold && !prevCh.completed)
        ? Math.max(1, Number(prevCh.play_count || 0) + (prevCh.completed ? 0 : 1))
        : Number(prevCh.play_count || (isDone ? 1 : 0));

    const nextChapters = {
      ...(current.chapters || {}),
      [chKey]: {
        position_sec: safePos,
        duration_sec: safeDur,
        completed: isDone,
        play_count: nextPlayCount,
        explicit_toggle: options && options.explicit_toggle !== undefined ? Boolean(options.explicit_toggle) : undefined,
        updated_at: now,
      },
    };

    const merged = {
      ...current,
      book_id: bookId,
      chapter_id: options && options.preserve_active_chapter && current.chapter_id ? current.chapter_id : chapterId,
      position_sec: options && options.preserve_active_chapter ? Number(current.position_sec || 0) : safePos,
      duration_sec:
        options && options.preserve_active_chapter
          ? Number(current.duration_sec || 0)
          : safeDur || Number(current.duration_sec) || 0,
      playback_rate: Number(playbackRate) || Number(current.playback_rate) || 1.0,
      times_completed: Number(current.times_completed || 0),
      relisten_pass: Number(current.relisten_pass || 1),
      pass_started_at: Number(current.pass_started_at || 0),
      last_paused_at:
        options && options.paused_now
          ? now
          : options && options.playing_now
          ? 0
          : Number(current.last_paused_at || 0),
      bookmarks: Array.isArray(current.bookmarks) ? current.bookmarks : [],
      updated_at: now,
      chapters: nextChapters,
    };

    const saved = this._writeMirrorItemSync(bookId, merged, true);
    this._enqueueIdbBackup(bookId, saved);
    return saved;
  }

  async savePlaybackState(bookId, stateUpdate, markDirty = true) {
    const now = stateUpdate.updated_at || Date.now();
    const current = (await this.getPlaybackState(bookId)) || this._defaultBookRecord(bookId, 1, 1.0, now);

    const isResetPass =
      Boolean(stateUpdate.reset_pass) &&
      Number(stateUpdate.pass_started_at || now) >= Number(current.pass_started_at || 0);
    const nextChapters = isResetPass ? {} : { ...(current.chapters || {}) };

    if (stateUpdate.chapters && typeof stateUpdate.chapters === 'object') {
      for (const [k, v] of Object.entries(stateUpdate.chapters)) {
        if (v && typeof v === 'object') {
          const prev = nextChapters[String(k)] || {};
          if (isResetPass || (v.updated_at || now) >= (prev.updated_at || 0)) {
            const safePos = Math.max(0, Number(v.position_sec) || 0);
            const safeDur = Number(v.duration_sec) || Number(prev.duration_sec) || 0;
            const reachedEnd = safeDur > 0 && (safePos / safeDur >= 0.92 || (safeDur >= 90 && safeDur - safePos <= 40));
            const nextCompleted =
              v.explicit_toggle !== undefined
                ? Boolean(v.explicit_toggle)
                : isResetPass
                ? Boolean(v.completed)
                : Boolean(v.completed || prev.completed || reachedEnd);
            nextChapters[String(k)] = {
              position_sec: safePos,
              duration_sec: safeDur,
              completed: nextCompleted,
              play_count: Math.max(Number(v.play_count || 0), Number(prev.play_count || (nextCompleted ? 1 : 0))),
              updated_at: v.updated_at || now,
            };
          }
        }
      }
    }

    if (
      stateUpdate.chapter_id !== undefined &&
      stateUpdate.position_sec !== undefined &&
      !stateUpdate.skip_direct_chapter_update
    ) {
      const chKey = String(stateUpdate.chapter_id);
      const prevCh = nextChapters[chKey] || {};
      const safePos = Math.max(0, Number(stateUpdate.position_sec) || 0);
      const safeDur = Number(stateUpdate.duration_sec) || Number(prevCh.duration_sec) || 0;
      const reachedEnd = safeDur > 0 && (safePos / safeDur >= 0.92 || (safeDur >= 90 && safeDur - safePos <= 40));
      const nextCompleted =
        stateUpdate.explicit_toggle !== undefined
          ? Boolean(stateUpdate.explicit_toggle)
          : isResetPass
          ? Boolean(stateUpdate.completed)
          : Boolean(stateUpdate.completed || prevCh.completed || reachedEnd);

      nextChapters[chKey] = {
        position_sec: safePos,
        duration_sec: safeDur,
        completed: nextCompleted,
        play_count: Math.max(Number(prevCh.play_count || 0), nextCompleted ? 1 : 0),
        updated_at: now,
      };
    }

    // Fusionar marcadores de audio por id único
    const bmMap = new Map();
    for (const bm of Array.isArray(current.bookmarks) ? current.bookmarks : []) {
      if (bm && bm.id) bmMap.set(bm.id, bm);
    }
    if (Array.isArray(stateUpdate.bookmarks)) {
      if (stateUpdate.replace_bookmarks) {
        bmMap.clear();
      }
      for (const bm of stateUpdate.bookmarks) {
        if (bm && bm.id) bmMap.set(bm.id, bm);
      }
    }

    const merged = {
      ...current,
      ...stateUpdate,
      book_id: bookId,
      times_completed: Math.max(Number(stateUpdate.times_completed || 0), Number(current.times_completed || 0)),
      relisten_pass: Math.max(Number(stateUpdate.relisten_pass || 1), Number(current.relisten_pass || 1)),
      pass_started_at: Math.max(Number(stateUpdate.pass_started_at || 0), Number(current.pass_started_at || 0)),
      bookmarks: Array.from(bmMap.values()).sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0)),
      chapters: nextChapters,
      updated_at: now,
    };
    delete merged.completed;
    delete merged.explicit_toggle;
    delete merged.skip_direct_chapter_update;
    delete merged.replace_bookmarks;

    const saved = this._writeMirrorItemSync(bookId, merged, markDirty);
    await this._enqueueIdbBackup(bookId, saved);
    return saved;
  }

  async toggleChapterCompleted(bookId, chapterId, forceState = null) {
    const current = (await this.getPlaybackState(bookId)) || this._defaultBookRecord(bookId, chapterId);
    const chKey = String(chapterId);
    const prevCh = (current.chapters && current.chapters[chKey]) || {};
    const targetCompleted = forceState !== null ? Boolean(forceState) : !Boolean(prevCh.completed);
    const now = Date.now();

    const nextChapters = {
      ...(current.chapters || {}),
      [chKey]: {
        position_sec: targetCompleted ? 0 : Number(prevCh.position_sec || 0),
        duration_sec: Number(prevCh.duration_sec || 0),
        completed: targetCompleted,
        play_count: targetCompleted ? Math.max(1, Number(prevCh.play_count || 0)) : Number(prevCh.play_count || 0),
        explicit_toggle: targetCompleted,
        updated_at: now,
      },
    };

    return await this.savePlaybackState(bookId, {
      ...current,
      chapters: nextChapters,
      skip_direct_chapter_update: true,
      updated_at: now,
    });
  }

  async markChaptersCompletedUpTo(bookId, upToChapterId, totalChapters = 0) {
    const current = (await this.getPlaybackState(bookId)) || this._defaultBookRecord(bookId, 1);
    const now = Date.now();
    const nextChapters = { ...(current.chapters || {}) };
    for (let i = 1; i <= upToChapterId; i++) {
      const k = String(i);
      const prev = nextChapters[k] || {};
      nextChapters[k] = {
        position_sec: 0,
        duration_sec: Number(prev.duration_sec || 0),
        completed: true,
        play_count: Math.max(1, Number(prev.play_count || 0)),
        explicit_toggle: true,
        updated_at: now,
      };
    }
    const nextActiveCh =
      totalChapters > 0
        ? Math.min(totalChapters, upToChapterId + 1)
        : Math.max(Number(current.chapter_id || 1), upToChapterId + 1);
    const activeChRec = nextChapters[String(nextActiveCh)] || {};

    return await this.savePlaybackState(bookId, {
      ...current,
      chapter_id: nextActiveCh,
      position_sec: Number(activeChRec.position_sec || 0),
      duration_sec: Number(activeChRec.duration_sec || 0),
      chapters: nextChapters,
      skip_direct_chapter_update: true,
      updated_at: now,
    });
  }

  async startNewBookReListenPass(bookId) {
    const current = (await this.getPlaybackState(bookId)) || this._defaultBookRecord(bookId, 1);
    const now = Date.now();
    const nextTimesCompleted = Number(current.times_completed || 0) + 1;
    const nextPass = Number(current.relisten_pass || 1) + 1;

    return await this.savePlaybackState(bookId, {
      book_id: bookId,
      chapter_id: 1,
      position_sec: 0,
      duration_sec: 0,
      playback_rate: Number(current.playback_rate || 1.0),
      times_completed: nextTimesCompleted,
      relisten_pass: nextPass,
      pass_started_at: now,
      bookmarks: Array.isArray(current.bookmarks) ? current.bookmarks : [],
      reset_pass: true,
      chapters: {},
      skip_direct_chapter_update: true,
      updated_at: now,
    });
  }

  // --- MARCADORES / NOTAS DE AUDIO (BOOKMARKS) ---
  async addAudioBookmark(bookId, bookmarkObj) {
    const current = (await this.getPlaybackState(bookId)) || this._defaultBookRecord(bookId, bookmarkObj.chapter_id || 1);
    const now = Date.now();
    const bm = {
      id: bookmarkObj.id || `bm_${now}_${Math.random().toString(36).slice(2, 6)}`,
      chapter_id: Number(bookmarkObj.chapter_id || 1),
      chapter_title: String(bookmarkObj.chapter_title || ''),
      position_sec: Math.max(0, Number(bookmarkObj.position_sec || 0)),
      note: String(bookmarkObj.note || ''),
      snippet: String(bookmarkObj.snippet || ''),
      created_at: now,
    };
    const nextBookmarks = [bm, ...(Array.isArray(current.bookmarks) ? current.bookmarks : [])];
    return await this.savePlaybackState(bookId, {
      ...current,
      bookmarks: nextBookmarks,
      replace_bookmarks: true,
      skip_direct_chapter_update: true,
      updated_at: now,
    });
  }

  async removeAudioBookmark(bookId, bookmarkId) {
    const current = await this.getPlaybackState(bookId);
    if (!current) return null;
    const now = Date.now();
    const nextBookmarks = (Array.isArray(current.bookmarks) ? current.bookmarks : []).filter((b) => b.id !== bookmarkId);
    return await this.savePlaybackState(bookId, {
      ...current,
      bookmarks: nextBookmarks,
      replace_bookmarks: true,
      skip_direct_chapter_update: true,
      updated_at: now,
    });
  }

  // --- HISTORIAL Y ESTADÍSTICAS DIARIAS DE ESCUCHA (100% LOCAL) ---
  getListeningActivitySync() {
    try {
      const raw = localStorage.getItem(ACTIVITY_LOG_KEY);
      return raw ? JSON.parse(raw) : { daily_seconds: {}, recent_events: [] };
    } catch (_) {
      return { daily_seconds: {}, recent_events: [] };
    }
  }

  logListeningSecondsSync(bookId, bookTitle, chapterId, chapterTitle, deltaSec) {
    if (!deltaSec || deltaSec <= 0 || deltaSec > 60) return;
    try {
      const log = this.getListeningActivitySync();
      const today = new Date().toISOString().slice(0, 10);
      log.daily_seconds = log.daily_seconds || {};
      log.daily_seconds[today] = Math.round((Number(log.daily_seconds[today] || 0) + deltaSec) * 10) / 10;

      // Conservar solo los últimos 30 días de estadísticas diarias
      const days = Object.keys(log.daily_seconds).sort();
      if (days.length > 30) {
        for (const oldDay of days.slice(0, days.length - 30)) {
          delete log.daily_seconds[oldDay];
        }
      }

      // Actualizar evento reciente (agrupando si es el mismo libro y capítulo hoy)
      log.recent_events = Array.isArray(log.recent_events) ? log.recent_events : [];
      const existingIdx = log.recent_events.findIndex(
        (ev) => ev.book_id === bookId && ev.chapter_id === chapterId && ev.date === today
      );
      if (existingIdx >= 0) {
        const prev = log.recent_events[existingIdx];
        prev.seconds_listened = Math.round((Number(prev.seconds_listened || 0) + deltaSec) * 10) / 10;
        prev.updated_at = Date.now();
        log.recent_events.splice(existingIdx, 1);
        log.recent_events.unshift(prev);
      } else {
        log.recent_events.unshift({
          book_id: bookId,
          book_title: bookTitle,
          chapter_id: chapterId,
          chapter_title: chapterTitle,
          date: today,
          seconds_listened: Math.round(deltaSec * 10) / 10,
          updated_at: Date.now(),
        });
      }
      if (log.recent_events.length > 35) {
        log.recent_events = log.recent_events.slice(0, 35);
      }
      localStorage.setItem(ACTIVITY_LOG_KEY, JSON.stringify(log));
    } catch (_) {}
  }

  // --- LECTURA Y RECONCILIACIÓN DE PROGRESO ---
  async getPlaybackState(bookId) {
    const mirrorMap = this._readMirrorMap();
    const mirrorVal = mirrorMap[bookId] || null;

    try {
      const db = await this.open();
      const idbVal = await new Promise((resolve, reject) => {
        const tx = db.transaction('playback', 'readonly');
        const req = tx.objectStore('playback').get(bookId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = (e) => reject(e.target.error);
      });

      if (mirrorVal && (!idbVal || Number(mirrorVal.updated_at || 0) >= Number(idbVal.updated_at || 0))) {
        return mirrorVal;
      }
      if (idbVal) {
        this._writeMirrorItemSync(bookId, idbVal, false);
        return idbVal;
      }
    } catch (_) {}
    return mirrorVal;
  }

  async getAllPlaybackStates() {
    const mirrorMap = this._readMirrorMap();
    let idbMap = {};
    try {
      const db = await this.open();
      idbMap = await new Promise((resolve, reject) => {
        const tx = db.transaction('playback', 'readonly');
        const req = tx.objectStore('playback').getAll();
        req.onsuccess = () => {
          const map = {};
          for (const item of req.result || []) {
            map[item.book_id] = item;
          }
          resolve(map);
        };
        req.onerror = (e) => reject(e.target.error);
      });
    } catch (_) {}

    const combined = { ...idbMap };
    let mirrorUpdated = false;
    for (const [bId, mVal] of Object.entries(mirrorMap)) {
      if (!combined[bId] || Number(mVal.updated_at || 0) >= Number(combined[bId].updated_at || 0)) {
        combined[bId] = mVal;
      }
    }
    // Si IndexedDB tenía algún libro que no estaba en localStorage (ej. tras limpiar caché parcial), hidratar mirror
    for (const [bId, iVal] of Object.entries(idbMap)) {
      if (!mirrorMap[bId] || Number(iVal.updated_at || 0) > Number(mirrorMap[bId].updated_at || 0)) {
        mirrorMap[bId] = iVal;
        mirrorUpdated = true;
      }
    }
    if (mirrorUpdated) {
      try {
        localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(mirrorMap));
      } catch (_) {}
    }
    return combined;
  }

  async reconcileWithServerProgress(serverProgress) {
    if (!serverProgress || typeof serverProgress.books !== 'object') {
      return { localNewerBooks: {} };
    }
    const localMap = await this.getAllPlaybackStates();
    const outbox = this._readOutbox();
    const serverBooks = serverProgress.books || {};
    const localNewerBooks = {};

    const allBookIds = new Set([...Object.keys(localMap), ...Object.keys(serverBooks)]);
    for (const bId of allBookIds) {
      const loc = localMap[bId];
      const rem = serverBooks[bId];
      const isLocallyDirty = Boolean(outbox[bId]);

      if (rem && !loc) {
        await this.savePlaybackState(bId, rem, false);
      } else if (loc && !rem) {
        if (
          isLocallyDirty ||
          (loc.position_sec || 0) > 0 ||
          Object.keys(loc.chapters || {}).length > 0 ||
          (Array.isArray(loc.bookmarks) && loc.bookmarks.length > 0)
        ) {
          localNewerBooks[bId] = loc;
        }
      } else if (loc && rem) {
        const locTs = Number(loc.updated_at || 0);
        const remTs = Number(rem.updated_at || 0);

        const combinedChapters = { ...(rem.chapters || {}) };
        let localHasNewerCh = false;
        for (const [chKey, lCh] of Object.entries(loc.chapters || {})) {
          const rCh = combinedChapters[chKey];
          if (!rCh || Number(lCh.updated_at || 0) > Number(rCh.updated_at || 0)) {
            combinedChapters[chKey] = lCh;
            localHasNewerCh = true;
          } else if (lCh.completed && !rCh.completed) {
            combinedChapters[chKey] = { ...rCh, completed: true };
            localHasNewerCh = true;
          }
        }

        // Combinar marcadores de ambos lados
        const bmMap = new Map();
        for (const bm of [...(rem.bookmarks || []), ...(loc.bookmarks || [])]) {
          if (bm && bm.id) bmMap.set(bm.id, bm);
        }
        const combinedBookmarks = Array.from(bmMap.values()).sort(
          (a, b) => Number(b.created_at || 0) - Number(a.created_at || 0)
        );
        const localHasMoreBm = combinedBookmarks.length > (rem.bookmarks || []).length;

        if (remTs > locTs && !isLocallyDirty) {
          await this.savePlaybackState(
            bId,
            {
              ...rem,
              bookmarks: combinedBookmarks,
              chapters: combinedChapters,
              updated_at: remTs,
            },
            false
          );
          if (localHasNewerCh || localHasMoreBm) {
            localNewerBooks[bId] = await this.getPlaybackState(bId);
          }
        } else if (locTs > remTs || isLocallyDirty || localHasNewerCh || localHasMoreBm) {
          const mergedLoc = await this.savePlaybackState(
            bId,
            {
              ...loc,
              bookmarks: combinedBookmarks,
              chapters: combinedChapters,
              updated_at: Math.max(locTs, remTs),
            },
            false
          );
          localNewerBooks[bId] = mergedLoc;
        }
      }
    }

    return { localNewerBooks };
  }
}

window.offlineDB = new OfflineAudioDB();
