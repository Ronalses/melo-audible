/**
 * app.js - Lógica principal de MeloAudible PWA (Offline-First + PC Sync + PDF/Audible)
 */

const GH_PAGES_DISCOVERY_URL = 'https://ronalses.github.io/melo-audible/tunnel_sync.json';

let serverBooks = [];
let serverVoices = [];
let geminiPoolStatus = null;
let offlineBooksMap = {};
let downloadedStats = { byBook: {}, totalBytes: 0 };
let playbackStates = {};
const voiceSampleAudio = new Audio();
let activeSampleVoiceId = null;

let isServerOnline = false;
let syncInFlight = false;
let syncLoopTimer = null;
let hasUserInteracted = false;
let detectedTunnelUrl = '';
let serverGhPagesUrl = 'https://ronalses.github.io/melo-audible/';
let serverPairingUrl = '';
let activeTab = 'library';
let libraryFilter = 'all';
let librarySearchQuery = '';
let librarySortMode = localStorage.getItem('melo_sort_mode') || 'recent_listen';
let chapterFilter = 'all';
let selectedBookId = null;
let selectedPdfFile = null;

// Estado del Reproductor
const audio = document.getElementById('mainAudio');
let currentPlayingBookId = localStorage.getItem('melo_last_book_id') || null;
let currentPlayingChapterId = parseInt(localStorage.getItem('melo_last_ch_id') || '1', 10);
let currentPlaybackRate = parseFloat(localStorage.getItem('melo_playback_rate') || '1.0');
let serverLastActiveBookId = null;
let isPlayerLoaded = false;
let pendingSeekSec = null;
let isRestoringSeek = false;
let currentObjectUrl = null;
let mediaArtworkObjectUrl = null;
let lastServerProgressSyncMs = 0;
let lastMediaPositionUpdateMs = 0;
let lastActivityLogWallMs = 0;
let sleepTimerMinutes = 0; // 0 = off, 15, 30, 45, -1 = fin del capítulo
let sleepTimeoutId = null;
let deferredInstallPrompt = null;

// --- AUTO-EMPAREJAMIENTO CIFRADO GITHUB PAGES (#pair=...) ---
function capturePairingHashFromUrl() {
  try {
    const hash = window.location.hash || '';
    const mHash = hash.match(/pair=([a-fA-F0-9]{24,64})/);
    const params = new URLSearchParams(window.location.search);
    const qPair = params.get('pair');
    const secret = (mHash && mHash[1]) || qPair || '';
    if (secret && secret.length >= 24) {
      localStorage.setItem('melo_pair_secret', secret.trim());
      if (mHash) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      setTimeout(() => showToast('🔐 Celular vinculado: auto-conexión con tu PC activada'), 400);
      return true;
    }
  } catch (_) {}
  return false;
}

async function _sha256Bytes(str) {
  const buf = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return new Uint8Array(digest);
}

function _bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function _hexToBytes(hex) {
  const clean = String(hex || '').trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

async function decryptTunnelSyncPayload(encObj, secretHex) {
  if (!encObj || !encObj.nonce || !encObj.ct || !encObj.mac || !secretHex) return null;
  const macBytes = await _sha256Bytes(`${secretHex}:mac:${encObj.nonce}:${encObj.ct}`);
  if (_bytesToHex(macBytes) !== String(encObj.mac).toLowerCase()) {
    return null;
  }
  const ctBytes = _hexToBytes(encObj.ct);
  const plainBytes = new Uint8Array(ctBytes.length);
  let offset = 0;
  let blk = 0;
  while (offset < ctBytes.length) {
    const ksBlock = await _sha256Bytes(`${secretHex}:enc:${encObj.nonce}:${blk}`);
    const take = Math.min(ksBlock.length, ctBytes.length - offset);
    for (let i = 0; i < take; i++) {
      plainBytes[offset + i] = ctBytes[offset + i] ^ ksBlock[i];
    }
    offset += take;
    blk++;
  }
  const decoded = JSON.parse(new TextDecoder().decode(plainBytes));
  return decoded && decoded.url ? String(decoded.url).trim() : null;
}

async function discoverEncryptedTunnelNow(silent = false) {
  const secret = localStorage.getItem('melo_pair_secret') || '';
  if (!secret) {
    if (!silent) {
      showToast('⚠️ Abre primero el Link Permanente de Emparejamiento desde tu PC.');
    }
    return null;
  }
  if (!navigator.onLine) {
    if (!silent) showToast('📴 Estás sin conexión a internet (Modo Offline activo).');
    return null;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const isGhPages = window.location.hostname.endsWith('github.io');
    const urlToFetch = (isGhPages ? './tunnel_sync.json' : GH_PAGES_DISCOVERY_URL) + '?t=' + Date.now();
    const res = await fetch(urlToFetch, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) return null;
    const encData = await res.json();
    const decryptedUrl = await decryptTunnelSyncPayload(encData, secret);
    if (decryptedUrl && decryptedUrl.startsWith('https://')) {
      const prev = localStorage.getItem('melo_server_url') || '';
      localStorage.setItem('melo_server_url', decryptedUrl);
      const inp = document.getElementById('serverUrlInput');
      if (inp) inp.value = decryptedUrl;
      if (!silent || prev !== decryptedUrl) {
        await syncWithServer(false);
        if (isServerOnline && !silent) {
          showToast('✅ ¡PC detectada y sincronizada automáticamente!');
          closeServerModal();
        }
      }
      return decryptedUrl;
    }
  } catch (_) {}
  if (!silent) {
    showToast('⚠️ No se detectó un túnel activo. Verifica que tu PC esté encendida.');
  }
  return null;
}

// --- CONFIGURACIÓN DE URL DEL SERVIDOR (SOPORTE GITHUB PAGES + TÚNEL CLOUDFLARE) ---
function isStaticFrontendHost() {
  const h = window.location.hostname.toLowerCase();
  return h.endsWith('github.io') || h.endsWith('pages.dev') || h.endsWith('netlify.app');
}

function getServerBaseUrl() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('server')) {
    const clean = normalizeServerUrl(params.get('server'));
    localStorage.setItem('melo_server_url', clean);
    try {
      params.delete('server');
      const qs = params.toString();
      history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
    } catch (_) {}
    return clean;
  }
  const saved = localStorage.getItem('melo_server_url');
  if (saved) return saved;
  if (isStaticFrontendHost()) return '';
  return window.location.origin;
}

function normalizeServerUrl(input) {
  let s = (input || '').trim().replace(/\/+$/, '');
  if (!s) return isStaticFrontendHost() ? '' : window.location.origin;
  if (/^[a-z0-9]+(-[a-z0-9]+){2,5}$/i.test(s) && !s.includes('.')) {
    return `https://${s.toLowerCase()}.trycloudflare.com`;
  }
  if (!/^https?:\/\//i.test(s)) {
    s = 'https://' + s;
  }
  return s;
}

function apiUrl(path) {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:') || path.startsWith('blob:')) {
    return path;
  }
  const base = getServerBaseUrl();
  if (!base) return path;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

function showToast(msg, durationMs = 3200) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.display = 'none';
  }, durationMs);
}

// --- REGISTRO DE SERVICE WORKER E INSTALACIÓN PWA (RUTA RELATIVA PARA GITHUB PAGES) ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Aviso registrando SW:', err);
    });
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('installPwaBtn');
  if (btn) btn.style.display = 'inline-flex';
});

async function promptInstallPWA() {
  if (!deferredInstallPrompt) {
    showToast('En iPhone/Safari: toca Compartir y luego "Agregar a pantalla de inicio"');
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.getElementById('installPwaBtn').style.display = 'none';
}

// --- COMBINACIÓN DE CATÁLOGO ONLINE (PC) + OFFLINE (TELÉFONO) ---
async function refreshLocalStorageState() {
  // Primero hidratar síncronamente desde localStorage para que el progreso jamás tenga retraso
  playbackStates = window.offlineDB.getAllPlaybackStatesSync();
  const offBooks = await window.offlineDB.getAllOfflineBooks();
  offlineBooksMap = {};
  for (const b of offBooks) {
    offlineBooksMap[b.id] = b;
  }
  downloadedStats = await window.offlineDB.getAllDownloadedStats();
  playbackStates = await window.offlineDB.getAllPlaybackStates();
}

function getMergedBooks() {
  const map = new Map();

  for (const b of Object.values(offlineBooksMap)) {
    map.set(b.id, { ...b, is_offline_cached: true });
  }

  if (isServerOnline) {
    for (const sb of serverBooks) {
      const prev = map.get(sb.id);
      map.set(sb.id, {
        ...(prev || {}),
        ...sb,
        cover_data_url: prev ? prev.cover_data_url : null,
      });
    }
  }

  return Array.from(map.values());
}

function getBookById(bookId) {
  return getMergedBooks().find((b) => b.id === bookId) || null;
}

function getBookCoverSrc(book) {
  if (!book) return './icons/icon.svg';
  if (!isServerOnline && book.cover_data_url) {
    return book.cover_data_url;
  }
  if (book.cover_url && getServerBaseUrl()) {
    return apiUrl(book.cover_url);
  }
  if (book.cover_data_url) {
    return book.cover_data_url;
  }
  return './icons/icon.svg';
}

async function flushOfflineOutboxToServer() {
  if (!isServerOnline || !navigator.onLine || !getServerBaseUrl()) return;
  const { dirtyBooks, maxTs, count } = window.offlineDB.getDirtyBooksPayloadSync();
  if (count === 0) return;

  try {
    const res = await fetch(apiUrl('/api/progress'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        books: dirtyBooks,
        last_active_book_id: currentPlayingBookId || undefined,
      }),
    });
    if (res.ok) {
      for (const bId of Object.keys(dirtyBooks)) {
        window.offlineDB.clearBookDirtySync(bId, maxTs);
      }
    }
  } catch (_) {}
}

// --- SINCRONIZACIÓN NO BLOQUEANTE CON SERVIDOR PC + AUTO-DESCUBRIMIENTO ---
async function syncWithServer(tryTunnelDiscoveryOnFail = true) {
  if (syncInFlight) return;
  syncInFlight = true;

  try {
    // Siempre refrescar progreso local primero
    playbackStates = {
      ...playbackStates,
      ...window.offlineDB.getAllPlaybackStatesSync(),
    };

    if (!navigator.onLine) {
      isServerOnline = false;
      return;
    }

    let base = getServerBaseUrl();
    if (!base && localStorage.getItem('melo_pair_secret') && tryTunnelDiscoveryOnFail) {
      base = (await discoverEncryptedTunnelNow(true)) || '';
    }
    if (!base) {
      isServerOnline = false;
      return;
    }

    const timeoutMs = isServerOnline ? 3200 : 1900;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(apiUrl('/api/books?t=' + Date.now()), {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    serverBooks = data.books || [];
    serverVoices = data.voices || [];
    geminiPoolStatus = data.gemini_pool || null;
    detectedTunnelUrl = data.tunnel_url || '';
    if (data.gh_pages_url) serverGhPagesUrl = data.gh_pages_url;
    if (data.pairing_url) serverPairingUrl = data.pairing_url;
    const becameOnline = !isServerOnline;
    isServerOnline = true;

    // 1. Enviar primero cualquier avance acumulado en la cola Offline (Sync Outbox)
    await flushOfflineOutboxToServer();

    // 2. Reconciliar bidireccionalmente progreso con el servidor sin pisar cambios locales nuevos
    if (data.playback_progress) {
      serverLastActiveBookId = data.playback_progress.last_active_book_id || null;
      const { localNewerBooks } = await window.offlineDB.reconcileWithServerProgress(data.playback_progress);
      if (Object.keys(localNewerBooks).length > 0) {
        fetch(apiUrl('/api/progress'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ books: localNewerBooks }),
        })
          .then((r) => {
            if (r.ok) {
              for (const bId of Object.keys(localNewerBooks)) {
                window.offlineDB.clearBookDirtySync(bId, Date.now());
              }
            }
          })
          .catch(() => {});
      }
      playbackStates = await window.offlineDB.getAllPlaybackStates();
    }

    // 3. Actualizar metadatos de libros guardados offline en el teléfono
    for (const sb of serverBooks) {
      if (offlineBooksMap[sb.id] || (downloadedStats.byBook[sb.id] && downloadedStats.byBook[sb.id].chapters.size > 0)) {
        await window.offlineDB.saveBookMetadata(sb);
        offlineBooksMap[sb.id] = { ...(offlineBooksMap[sb.id] || {}), ...sb };
      }
    }

    // Si acaba de conectar por primera vez y el usuario aún no cargó reproductor, restaurar sesión
    if (becameOnline && !isPlayerLoaded && !hasUserInteracted) {
      restoreLastPlayerSession();
    }
  } catch (_) {
    const wasOnline = isServerOnline;
    isServerOnline = false;
    // Si falló el túnel viejo pero tenemos clave de auto-emparejamiento, buscar el nuevo túnel cifrado en GitHub Pages
    if (tryTunnelDiscoveryOnFail && navigator.onLine && localStorage.getItem('melo_pair_secret')) {
      syncInFlight = false;
      const newUrl = await discoverEncryptedTunnelNow(true);
      if (newUrl) {
        return await syncWithServer(false);
      }
      return;
    }
    if (wasOnline) {
      showToast('📴 Modo Offline activado • Tu progreso se sigue guardando en el teléfono');
    }
  } finally {
    syncInFlight = false;
    updateHeaderStatus();
    updateLiveWorkerBanner();
    renderCurrentView();
  }
}

function updateHeaderStatus() {
  const pill = document.getElementById('connPill');
  const txt = document.getElementById('connText');
  const totalMB = (downloadedStats.totalBytes / (1024 * 1024)).toFixed(1);
  const pendingCount = window.offlineDB.getPendingOutboxCountSync();

  if (isServerOnline) {
    pill.classList.remove('offline');
    txt.textContent = Number(totalMB) > 0 ? `PC Conectada • ${totalMB} MB Offline` : 'PC Conectada';
  } else {
    pill.classList.add('offline');
    const syncBadge = pendingCount > 0 ? ` • ✓ Progreso guardado` : '';
    txt.textContent = `Offline (${totalMB} MB)${syncBadge}`;
  }
}

function updateLiveWorkerBanner() {
  const banner = document.getElementById('liveWorkerBanner');
  if (!isServerOnline) {
    banner.style.display = 'none';
    return;
  }

  const activeBook =
    serverBooks.find((b) => b.status === 'processing') ||
    serverBooks.find((b) => b.status !== 'paused' && b.ready_chapters < b.total_chapters);
  if (!activeBook) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'block';
  const ready = activeBook.ready_chapters || 0;
  const total = activeBook.total_chapters || 1;
  const pct = Math.round((ready / total) * 100);

  document.getElementById('lwbTitle').textContent = `Traduciendo: ${activeBook.book_title_es}`;
  document.getElementById('lwbCount').textContent = `${ready}/${total} caps (${pct}%)`;
  document.getElementById('lwbBookFill').style.width = `${pct}%`;
  document.getElementById('lwbStepDetail').textContent =
    activeBook.active_detail || `Procesando capítulo (${activeBook.active_pct || 0}%)`;
  document.getElementById('lwbUpdated').textContent = activeBook.updated_at
    ? `Latido: ${activeBook.updated_at}`
    : 'En vivo';
}

// --- NAVEGACIÓN ENTRE PESTAÑAS ---
function switchTab(tab) {
  activeTab = tab;
  document.getElementById('viewLibrary').style.display = tab === 'library' ? 'block' : 'none';
  document.getElementById('viewCreate').style.display = tab === 'create' ? 'block' : 'none';
  document.getElementById('viewQueue').style.display = tab === 'queue' ? 'block' : 'none';

  document.getElementById('navLibrary').classList.toggle('active', tab === 'library');
  document.getElementById('navCreate').classList.toggle('active', tab === 'create');
  document.getElementById('navQueue').classList.toggle('active', tab === 'queue');

  if (tab === 'create' && isServerOnline) {
    fetchLocalAudibleBooks();
  }
  renderCurrentView();
}

function renderCurrentView() {
  if (activeTab === 'library') {
    if (selectedBookId) {
      renderBookDetail();
    } else {
      renderLibraryGrid();
    }
  } else if (activeTab === 'create') {
    renderVoiceTesterList();
  } else if (activeTab === 'queue') {
    renderQueueView();
  }
}

// --- ESTADÍSTICAS Y GESTIÓN DE PROGRESO DE ESCUCHA POR LIBRO Y CAPÍTULO ---
function getBookListeningStats(book) {
  const chapters = book.chapters || [];
  const totalCh = book.total_chapters || chapters.length || 1;
  const pb = playbackStates[book.id] || null;
  const chMap = (pb && pb.chapters) || {};

  let completedCount = 0;
  let partialCount = 0;
  let partialFractionSum = 0;
  let remainingBaseSec = 0;
  const completedIdSet = new Set();

  for (const ch of chapters) {
    const rec = chMap[String(ch.id)];
    const isPlayingNow =
      isPlayerLoaded && currentPlayingBookId === book.id && currentPlayingChapterId === ch.id && !isRestoringSeek;
    const pos = isPlayingNow ? audio.currentTime || (rec ? rec.position_sec : 0) : rec ? Number(rec.position_sec || 0) : 0;
    const dur = (rec && Number(rec.duration_sec)) || (ch.actual_min || ch.duration_min || 0) * 60;

    if (rec && rec.completed) {
      completedCount++;
      completedIdSet.add(ch.id);
    } else if (pos > 2) {
      partialCount++;
      if (dur > 0) {
        partialFractionSum += Math.min(0.95, pos / dur);
        remainingBaseSec += Math.max(0, dur - pos);
      }
    } else if (dur > 0) {
      remainingBaseSec += dur;
    }
  }

  // Si el libro no tenía array de capítulos cargado aún pero sí registro en chMap
  if (chapters.length === 0 && pb && pb.chapters) {
    for (const [k, rec] of Object.entries(pb.chapters)) {
      if (rec && rec.completed) {
        completedCount++;
        completedIdSet.add(Number(k));
      } else if (rec && Number(rec.position_sec || 0) > 2) {
        partialCount++;
      }
    }
  }

  const effectiveRate = currentPlaybackRate > 0 ? currentPlaybackRate : 1.0;
  const remainingAdjustedMin = Math.round(remainingBaseSec / effectiveRate / 60);

  const rawPct = totalCh > 0 ? Math.round(((completedCount + partialFractionSum) / totalCh) * 100) : 0;
  const listenPct = Math.min(100, Math.max(0, rawPct));
  const bookmarkChId = pb && pb.chapter_id ? Number(pb.chapter_id) : 1;
  const bookmarkCh =
    chapters.find((c) => c.id === bookmarkChId) ||
    chapters[0] || { id: bookmarkChId, title_es: `Capítulo ${bookmarkChId}` };
  const bookmarkChProg = getSavedChapterProgress(book.id, bookmarkChId);
  const isPlayingBookmark =
    isPlayerLoaded &&
    currentPlayingBookId === book.id &&
    currentPlayingChapterId === bookmarkChId &&
    !isRestoringSeek;
  const bookmarkPosSec = isPlayingBookmark
    ? audio.currentTime || (bookmarkChProg ? bookmarkChProg.position_sec : (pb && pb.position_sec) || 0)
    : bookmarkChProg
    ? bookmarkChProg.position_sec
    : (pb && pb.position_sec) || 0;
  const bookmarkDurSec =
    (bookmarkChProg && bookmarkChProg.duration_sec) ||
    (pb && pb.duration_sec) ||
    (bookmarkCh.actual_min || bookmarkCh.duration_min || 0) * 60;
  const bookmarkPct =
    bookmarkDurSec > 0 ? Math.min(100, Math.round((bookmarkPosSec / bookmarkDurSec) * 100)) : 0;

  const timesCompleted = pb ? Number(pb.times_completed || 0) : 0;
  const relistenPass = pb ? Number(pb.relisten_pass || 1) : 1;
  const isStarted =
    completedCount > 0 ||
    partialCount > 0 ||
    Boolean(pb && ((pb.position_sec || 0) > 2 || (pb.chapter_id || 1) > 1));
  const isAllListened = totalCh > 0 && completedCount >= totalCh;
  const isInProgress = isStarted && !isAllListened;
  const unplayedCount = Math.max(0, totalCh - completedCount - partialCount);

  return {
    pb,
    totalCh,
    completedCount,
    partialCount,
    unplayedCount,
    listenPct,
    bookmarkChId,
    bookmarkCh,
    bookmarkPosSec,
    bookmarkDurSec,
    bookmarkPct,
    timesCompleted,
    relistenPass,
    isStarted,
    isAllListened,
    isInProgress,
    completedIdSet,
    remainingAdjustedMin,
    bookmarks: pb && Array.isArray(pb.bookmarks) ? pb.bookmarks : [],
    updatedAt: pb ? Number(pb.updated_at || 0) : 0,
  };
}

function formatMinutesCompact(totalMin) {
  if (!totalMin || totalMin <= 0) return '0 min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

function onLibrarySearchInput(val) {
  librarySearchQuery = String(val || '').trim().toLowerCase();
  renderLibraryGrid();
}

function onLibrarySortChange(val) {
  librarySortMode = val || 'recent_listen';
  localStorage.setItem('melo_sort_mode', librarySortMode);
  renderLibraryGrid();
}

async function cleanupCompletedOfflineChapters(bookId) {
  const book = getBookById(bookId);
  if (!book) return;
  const stats = getBookListeningStats(book);
  if (stats.completedIdSet.size === 0) return;

  const { deletedCount, freedBytes } = await window.offlineDB.deleteCompletedBookAudio(
    bookId,
    Array.from(stats.completedIdSet)
  );
  if (deletedCount === 0) {
    showToast('No había capítulos ya escuchados ocupando espacio en el teléfono.');
    return;
  }
  await refreshLocalStorageState();
  updateHeaderStatus();
  renderCurrentView();
  const mb = (freedBytes / (1024 * 1024)).toFixed(1);
  showToast(`🧹 Liberados ${deletedCount} capítulos ya escuchados (${mb} MB) • Tu progreso sigue intacto.`);
}

async function toggleChapterListenedStatus(bookId, chapterId) {
  const updated = await window.offlineDB.toggleChapterCompleted(bookId, chapterId);
  playbackStates[bookId] = updated;
  pushProgressToServer(updated);
  const chRec = updated.chapters && updated.chapters[String(chapterId)];
  showToast(
    chRec && chRec.completed
      ? `✅ Capítulo ${chapterId} marcado como escuchado`
      : `⚪ Capítulo ${chapterId} marcado como pendiente`,
    2200
  );
  renderCurrentView();
}

async function markPreviousChaptersListened(bookId, upToChapterId) {
  const book = getBookById(bookId);
  const totalCh = book ? book.total_chapters || (book.chapters || []).length : 0;
  const updated = await window.offlineDB.markChaptersCompletedUpTo(bookId, upToChapterId, totalCh);
  playbackStates[bookId] = updated;
  pushProgressToServer(updated);
  showToast(`✅ Capítulos 1 al ${upToChapterId} marcados como escuchados • Quedaste en Cap. ${updated.chapter_id}`);
  renderCurrentView();
}

async function startNewReListenPass(bookId) {
  const book = getBookById(bookId);
  if (!book) return;
  const stats = getBookListeningStats(book);
  const confirmMsg =
    stats.completedCount > 0 || stats.partialCount > 0
      ? `¿Iniciar una nueva vuelta de escucha para "${book.book_title_es}"?\n\nSe guardará en tu historial que ya lo escuchaste (${stats.timesCompleted + 1}x) y se reiniciarán los capítulos para empezar desde el Capítulo 1.`
      : `¿Reiniciar el progreso de "${book.book_title_es}" al Capítulo 1?`;
  if (!window.confirm(confirmMsg)) return;

  const updated = await window.offlineDB.startNewBookReListenPass(bookId);
  playbackStates[bookId] = updated;
  pushProgressToServer(updated);
  showToast(`🔄 ¡Iniciada vuelta #${updated.relisten_pass} de "${book.book_title_es}" desde el Capítulo 1!`);
  renderCurrentView();
  await playChapter(bookId, 1, true, true);
}

// --- VISTA 1A: GRILLA DE BIBLIOTECA ---
function setLibraryFilter(filter, btn) {
  libraryFilter = filter;
  document.querySelectorAll('#libraryListContainer .chip').forEach((c) => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderLibraryGrid();
}

function renderContinueListeningCard(allBooks) {
  const box = document.getElementById('continueListeningBox');
  if (!box) return;

  // Mostrar TODOS los audiolibros en curso (o recién escuchados), ordenados por última actividad
  const activeItems = [];
  for (const b of allBooks) {
    const stats = getBookListeningStats(b);
    if (!stats.isStarted) continue;
    activeItems.push({ book: b, stats });
  }

  activeItems.sort((a, b) => b.stats.updatedAt - a.stats.updatedAt);

  if (activeItems.length === 0) {
    box.style.display = 'none';
    return;
  }

  box.style.display = 'block';
  box.innerHTML = `
    <div class="active-books-section">
      <div class="active-books-header">
        <span>🎧 TUS AUDIOLIBROS EN CURSO (${activeItems.length})</span>
        <span style="color: var(--muted); font-weight: 600; font-size: 0.74rem;">Toca cualquiera para retomar donde quedaste</span>
      </div>
      <div class="active-books-list">
        ${activeItems
          .map(({ book, stats }) => {
            const ch = stats.bookmarkCh;
            const posSec = stats.bookmarkPosSec;
            const estDurSec = stats.bookmarkDurSec;
            const pct = stats.bookmarkPct;
            const coverSrc = getBookCoverSrc(book);
            const isActivelyPlaying =
              isPlayerLoaded &&
              !audio.paused &&
              currentPlayingBookId === book.id &&
              currentPlayingChapterId === ch.id;
            const passTag =
              stats.relistenPass > 1 || stats.timesCompleted > 0
                ? `<span class="badge offline" style="margin-left: 6px;">🔄 ${stats.relistenPass}ª vuelta (🏆 ${stats.timesCompleted}x)</span>`
                : '';

            return `
              <div class="continue-card">
                <img
                  class="continue-cover"
                  src="${coverSrc}"
                  onerror="this.src='./icons/icon.svg'"
                  alt="Portada"
                  onclick="openBookDetail('${book.id}')"
                />
                <div class="continue-body" onclick="openBookDetail('${book.id}')">
                  <div class="continue-kicker">
                    📍 Quedaste en Cap. ${ch.id} de ${stats.totalCh} • ✅ ${stats.completedCount}/${stats.totalCh} escuchados (${stats.listenPct}%)
                    ${passTag}
                  </div>
                  <div class="continue-title">${escapeHtml(book.book_title_es)}</div>
                  <div class="continue-sub">
                    <strong>Cap. ${ch.id}: ${escapeHtml(ch.title_es || '')}</strong> • ⏱ En <strong>${formatTime(
              posSec
            )}</strong>${estDurSec > 0 ? ` / ${formatTime(estDurSec)} (${pct}%)` : ''}
                  </div>
                  <div class="progress-track" style="height: 5px;">
                    <div class="progress-fill gold" style="width: ${Math.max(pct, stats.listenPct > 0 ? 4 : 0)}%;"></div>
                  </div>
                </div>
                <button
                  class="btn btn-primary"
                  style="flex: 0 0 auto; padding: 10px 14px; font-size: 0.8rem;"
                  onclick="event.stopPropagation(); ${
                    isActivelyPlaying
                      ? 'togglePlay()'
                      : `playChapter('${book.id}', ${ch.id}, true)`
                  }"
                >
                  ${isActivelyPlaying ? '⏸ Pausar' : `▶ Cap. ${ch.id}`}
                </button>
              </div>
            `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderLibraryGrid() {
  const container = document.getElementById('booksGrid');
  const allBooks = getMergedBooks();
  renderContinueListeningCard(allBooks);

  const sortSelect = document.getElementById('librarySortSelect');
  if (sortSelect && sortSelect.value !== librarySortMode) {
    sortSelect.value = librarySortMode;
  }

  const filtered = allBooks.filter((b) => {
    if (librarySearchQuery) {
      const hay = `${b.book_title_es || ''} ${b.book_title_en || ''} ${b.author || ''}`.toLowerCase();
      if (!hay.includes(librarySearchQuery)) return false;
    }
    const dlCount = downloadedStats.byBook[b.id] ? downloadedStats.byBook[b.id].chapters.size : 0;
    const stats = getBookListeningStats(b);
    if (libraryFilter === 'in_progress') return stats.isInProgress;
    if (libraryFilter === 'completed') return stats.isAllListened || stats.timesCompleted > 0;
    if (libraryFilter === 'unstarted') return !stats.isStarted;
    if (libraryFilter === 'offline') return dlCount > 0;
    if (libraryFilter === 'audible') return b.source_type === 'audible';
    if (libraryFilter === 'pdf') return b.source_type === 'pdf';
    return true;
  });

  filtered.sort((a, b) => {
    const sa = getBookListeningStats(a);
    const sb = getBookListeningStats(b);
    if (librarySortMode === 'recent_listen') {
      if (sb.updatedAt !== sa.updatedAt) return sb.updatedAt - sa.updatedAt;
      return 0;
    }
    if (librarySortMode === 'progress') {
      if (sb.listenPct !== sa.listenPct) return sb.listenPct - sa.listenPct;
      return sb.updatedAt - sa.updatedAt;
    }
    if (librarySortMode === 'title') {
      return String(a.book_title_es || '').localeCompare(String(b.book_title_es || ''), 'es');
    }
    return 0;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="section-card" style="text-align: center; padding: 32px 18px;">
        <div style="font-size: 2.4rem; margin-bottom: 10px;">🎧</div>
        <h3 style="margin-bottom: 6px;">No hay audiolibros en este filtro</h3>
        <p style="font-size: 0.84rem; color: var(--muted); margin-bottom: 16px;">
          ${
            librarySearchQuery
              ? `No se encontraron resultados para "${escapeHtml(librarySearchQuery)}".`
              : 'Cambia el filtro superior a "📚 Todos" o descarga capítulos cuando estés conectado a tu PC.'
          }
        </p>
        <button class="btn btn-secondary" onclick="document.getElementById('librarySearchInput').value=''; librarySearchQuery=''; setLibraryFilter('all', document.querySelector('#libraryListContainer .chip'))">📚 Ver Todos los Libros</button>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .map((b) => {
      const ready = b.ready_chapters || 0;
      const total = b.total_chapters || 1;
      const genPct = Math.round((ready / total) * 100);
      const dlSet = downloadedStats.byBook[b.id] ? downloadedStats.byBook[b.id].chapters : new Set();
      const dlCount = dlSet.size;
      const dlMB = downloadedStats.byBook[b.id]
        ? (downloadedStats.byBook[b.id].bytes / (1024 * 1024)).toFixed(1)
        : '0.0';
      const stats = getBookListeningStats(b);
      const coverSrc = getBookCoverSrc(b);

      let listeningBadge = '';
      if (stats.isAllListened) {
        listeningBadge = `<span class="badge offline">🏆 Completado (${stats.completedCount}/${total} caps)${
          stats.timesCompleted > 1 ? ` • ${stats.timesCompleted}x` : ''
        }</span>`;
      } else if (stats.isStarted) {
        listeningBadge = `<span class="badge audible">📍 Quedaste en Cap. ${stats.bookmarkChId}${
          stats.bookmarkPosSec > 2 ? ` (${formatTime(stats.bookmarkPosSec)})` : ''
        }</span>`;
      } else {
        listeningBadge = `<span class="badge" style="background: rgba(148,163,184,0.14); color: var(--muted);">⚪ Sin empezar</span>`;
      }

      const relistenBadge =
        stats.timesCompleted > 0 && !stats.isAllListened
          ? `<span class="badge offline">🔄 ${stats.relistenPass}ª vuelta (🏆 ${stats.timesCompleted}x)</span>`
          : '';

      const offlineBadge =
        dlCount > 0
          ? `<span class="badge pdf">📱 ${dlCount}/${ready} offline (${dlMB} MB)</span>`
          : '';

      const genBadge =
        ready < total
          ? `<span class="badge pdf">⚙️ Generados: ${ready}/${total} (${genPct}%)</span>`
          : '';

      const remTimeHint =
        !stats.isAllListened && stats.remainingAdjustedMin > 0
          ? ` • Restan ${formatMinutesCompact(stats.remainingAdjustedMin)}`
          : '';

      const resumeHint = stats.isStarted
        ? `▶ Seguir Cap. ${stats.bookmarkChId}${stats.bookmarkPosSec > 2 ? ` (${formatTime(stats.bookmarkPosSec)})` : ''}`
        : `▶ Empezar Cap. 1 (${formatMinutesCompact(b.total_duration_min || stats.remainingAdjustedMin)})`;

      return `
        <div class="book-card" onclick="openBookDetail('${b.id}')">
          <div class="book-cover-wrap">
            <img src="${coverSrc}" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" alt="Portada" />
            <span class="cover-fallback" style="display: none;">📘</span>
          </div>
          <div class="book-card-body">
            <div class="badges-row">
              ${listeningBadge}
              ${relistenBadge}
              ${offlineBadge}
              ${genBadge}
            </div>
            <div class="book-card-title">${escapeHtml(b.book_title_es)}</div>
            <div class="book-card-author">${escapeHtml(b.author || 'Autor')} • 🎙️ ${escapeHtml(b.voice || 'Sulafat')}${remTimeHint}</div>
            <div class="progress-track" style="height: 6px;">
              <div class="progress-fill ${stats.isAllListened ? '' : 'gold'}" style="width: ${stats.listenPct}%;"></div>
            </div>
            <div class="book-card-footer">
              <span>✅ <strong>${stats.completedCount}/${total}</strong> caps escuchados (${stats.listenPct}%)</span>
              <span style="color: var(--accent-hover); font-weight: 800;">${resumeHint} →</span>
            </div>
          </div>
        </div>
      `;
    })
    .join('');
}

// --- VISTA 1B: DETALLE DE LIBRO Y DESCARGA OFFLINE ---
function openBookDetail(bookId) {
  selectedBookId = bookId;
  document.getElementById('libraryListContainer').style.display = 'none';
  document.getElementById('bookDetailContainer').style.display = 'block';
  renderBookDetail();
}

function closeBookDetail() {
  selectedBookId = null;
  document.getElementById('bookDetailContainer').style.display = 'none';
  document.getElementById('libraryListContainer').style.display = 'block';
  renderLibraryGrid();
}

function setChapterFilter(filter, btn) {
  chapterFilter = filter;
  document.querySelectorAll('#bookDetailContainer .chip').forEach((c) => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderBookDetail();
}

function renderBookDetail() {
  const b = getBookById(selectedBookId);
  if (!b) {
    closeBookDetail();
    return;
  }

  const hero = document.getElementById('bookDetailHero');
  const chapters = b.chapters || [];
  const readyChapters = chapters.filter((c) => c.status === 'ready');
  const dlSet = downloadedStats.byBook[b.id] ? downloadedStats.byBook[b.id].chapters : new Set();
  const dlCount = dlSet.size;
  const dlMB = downloadedStats.byBook[b.id]
    ? (downloadedStats.byBook[b.id].bytes / (1024 * 1024)).toFixed(1)
    : '0.0';
  const stats = getBookListeningStats(b);
  const resumeChId = stats.bookmarkChId;
  const resumeSec = stats.bookmarkPosSec;
  const resumeChObj = stats.bookmarkCh;
  const coverSrc = getBookCoverSrc(b);

  let completedDlCount = 0;
  for (const cid of stats.completedIdSet) {
    if (dlSet.has(cid)) completedDlCount++;
  }

  const allReadyDownloaded = readyChapters.length > 0 && readyChapters.every((c) => dlSet.has(c.id));
  const isPaused = b.status === 'paused';
  const isDone = readyChapters.length >= chapters.length && chapters.length > 0;

  // Evitar pisar el DOM del hero mientras el usuario tiene desplegado el selector de voz
  const activeEl = document.activeElement;
  if (activeEl && activeEl.id === 'bookDetailVoiceSelect') {
    return;
  }

  const voicesList = serverVoices && serverVoices.length > 0 ? serverVoices : [];
  const voiceOptionsHtml = voicesList
    .map(
      (v) =>
        `<option value="${escapeHtml(v.id)}" ${v.id === b.voice_id ? 'selected' : ''}>${escapeHtml(v.name)}</option>`
    )
    .join('');

  const bookmarksHtml =
    stats.bookmarks.length > 0
      ? `
      <div style="margin-bottom: 14px;">
        <div style="font-size: 0.78rem; font-weight: 800; color: #fbbf24; margin-bottom: 6px;">
          🔖 Tus Citas y Marcadores en este Libro (${stats.bookmarks.length})
        </div>
        ${stats.bookmarks
          .slice(0, 6)
          .map(
            (bm) => `
          <div class="bookmark-card">
            <div style="flex: 1; min-width: 0; cursor: pointer;" onclick="jumpToAudioBookmark('${b.id}', ${bm.chapter_id}, ${bm.position_sec})">
              <div style="font-size: 0.78rem; font-weight: 800; color: var(--text);">
                ▶ Cap. ${bm.chapter_id} • ${formatTime(bm.position_sec)} ${bm.note ? `— ${escapeHtml(bm.note)}` : ''}
              </div>
              ${
                bm.snippet
                  ? `<div style="font-size: 0.74rem; color: var(--muted); margin-top: 2px;">"${escapeHtml(bm.snippet)}"</div>`
                  : ''
              }
            </div>
            <button class="close-sheet-btn" style="padding: 3px 8px; font-size: 0.7rem;" onclick="deleteAudioBookmark('${b.id}', '${escapeHtml(bm.id)}')" title="Borrar marcador">✕</button>
          </div>
        `
          )
          .join('')}
      </div>
    `
      : '';

  hero.innerHTML = `
    <div class="book-hero-top">
      <img class="hero-cover" src="${coverSrc}" onerror="this.src='./icons/icon.svg'" alt="Portada" />
      <div class="hero-meta">
        <div class="badges-row" style="margin-bottom: 6px;">
          <span class="badge ${b.source_type === 'audible' ? 'audible' : 'pdf'}">
            ${b.source_type === 'audible' ? '🎧 Audible Traducido' : '📄 PDF a Audiolibro'}
          </span>
          ${dlCount > 0 ? `<span class="badge offline">📱 ${dlCount} caps en teléfono (${dlMB} MB)</span>` : ''}
          ${
            stats.timesCompleted > 0
              ? `<span class="badge offline">🏆 Escuchado ${stats.timesCompleted}x • 🔄 Vuelta #${stats.relistenPass}</span>`
              : ''
          }
        </div>
        <h1>${escapeHtml(b.book_title_es)}</h1>
        <div class="sub">
          ${escapeHtml(b.author || '')} • ${readyChapters.length}/${chapters.length} caps${
    !stats.isAllListened && stats.remainingAdjustedMin > 0
      ? ` • ⏱ Restan ${formatMinutesCompact(stats.remainingAdjustedMin)} a ${currentPlaybackRate}x`
      : ''
  }
        </div>
        <div style="font-size: 0.76rem; color: #fbbf24; font-weight: 700;">🎙️ ${escapeHtml(b.voice || 'Sulafat')}</div>
      </div>
    </div>

    <!-- Tarjeta Resumen de Progreso de Escucha en este Libro -->
    <div class="book-listening-summary">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 6px;">
        <div style="font-size: 0.82rem; font-weight: 800; color: #fbbf24;">
          ${
            stats.isAllListened
              ? `🏆 ¡Audiolibro 100% Escuchado! (${stats.completedCount}/${stats.totalCh} capítulos)`
              : stats.isStarted
              ? `📍 Quedaste en Cap. ${resumeChId}: ${escapeHtml(resumeChObj.title_es || '')}${
                  resumeSec > 2 ? ` (${formatTime(resumeSec)})` : ''
                }`
              : `⚪ Aún no has empezado a escuchar este audiolibro`
          }
        </div>
        <span style="font-size: 0.75rem; font-weight: 800; color: var(--emerald);">
          ${stats.listenPct}% del libro escuchado
        </span>
      </div>
      <div class="progress-track" style="height: 6px; margin-bottom: 8px;">
        <div class="progress-fill ${stats.isAllListened ? '' : 'gold'}" style="width: ${stats.listenPct}%;"></div>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 0.75rem; color: var(--text-secondary);">
        <div>
          <span>✅ <strong>${stats.completedCount}</strong> escuchados</span>
          <span style="margin-left: 10px;">⏳ <strong>${stats.partialCount}</strong> a mitad</span>
          <span style="margin-left: 10px;">⚪ <strong>${stats.unplayedCount}</strong> por escuchar</span>
        </div>
        ${
          stats.isStarted || stats.timesCompleted > 0
            ? `
          <button
            type="button"
            class="ch-batch-btn"
            onclick="startNewReListenPass('${b.id}')"
            title="Guarda que ya lo escuchaste e inicia una nueva vuelta desde el Capítulo 1"
          >
            🔄 Volver a escuchar libro (Nueva vuelta)
          </button>
        `
            : ''
        }
      </div>
    </div>

    ${bookmarksHtml}

    ${
      isServerOnline && voicesList.length > 0
        ? `
      <div style="background: rgba(15,23,42,0.75); border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; margin-bottom: 12px;">
        <div style="font-size: 0.75rem; color: var(--muted); font-weight: 700; margin-bottom: 6px;">
          🎙️ Narrador del Libro (Prueba cualquier voz antes de iniciar)
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
          <select
            id="bookDetailVoiceSelect"
            class="form-select"
            style="flex: 1; min-width: 210px; padding: 8px 10px; font-size: 0.82rem;"
            onchange="switchBookVoice('${b.id}', this.value)"
          >
            ${voiceOptionsHtml}
          </select>
          <button
            type="button"
            class="btn btn-secondary"
            style="padding: 8px 12px; font-size: 0.8rem;"
            onclick="previewVoiceSample(document.getElementById('bookDetailVoiceSelect').value, this)"
          >
            ${activeSampleVoiceId ? '⏹ Detener Muestra' : '🔊 Probar Voz'}
          </button>
          ${
            !isDone
              ? `
            <button
              type="button"
              class="btn ${isPaused ? 'btn-primary' : 'btn-secondary'}"
              style="padding: 8px 13px; font-size: 0.8rem;"
              onclick="toggleBookPause('${b.id}', ${!isPaused})"
            >
              ${isPaused ? '🚀 Iniciar / Reanudar Narración' : '⏸ Pausar Narración'}
            </button>
          `
              : ''
          }
        </div>
      </div>
    `
        : ''
    }

    ${
      b.ready_chapters < b.total_chapters && isServerOnline
        ? `
      <div style="background: rgba(8,12,20,0.55); border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; margin-bottom: 14px;">
        <div style="display: flex; justify-content: space-between; font-size: 0.78rem; margin-bottom: 5px;">
          <span style="color: var(--blue); font-weight: 700;">⏳ ${escapeHtml(b.active_detail || 'Procesando en PC...')}</span>
          <span style="color: var(--muted);">${b.active_pct || 0}%</span>
        </div>
        <div class="progress-track" style="height: 5px;">
          <div class="progress-fill" style="width: ${b.active_pct || 0}%;"></div>
        </div>
      </div>
    `
        : ''
    }

    <div class="hero-actions">
      <button
        class="btn btn-primary"
        ${readyChapters.length === 0 && dlCount === 0 ? 'disabled' : ''}
        onclick="playChapter('${b.id}', ${resumeChId}, true)"
      >
        ▶ ${
          stats.isStarted
            ? `Continuar Cap. ${resumeChId}${resumeSec > 2 ? ` (${formatTime(resumeSec)})` : ''}`
            : 'Empezar Cap. 1'
        }
      </button>

      ${
        isServerOnline
          ? `
        <button
          class="btn btn-secondary"
          ${readyChapters.length === 0 || allReadyDownloaded ? 'disabled' : ''}
          onclick="downloadFullBookOffline('${b.id}')"
        >
          ${
            allReadyDownloaded
              ? `✓📱 Todo Descargado (${dlCount} caps)`
              : `⬇ Descargar al Teléfono (${readyChapters.length} caps)`
          }
        </button>
      `
          : ''
      }

      ${
        completedDlCount > 0
          ? `
        <button
          class="btn btn-secondary"
          style="flex: 0 1 auto; padding: 9px 13px; font-size: 0.78rem;"
          onclick="cleanupCompletedOfflineChapters('${b.id}')"
          title="Borra de la memoria del teléfono únicamente los MP3 de los capítulos que ya escuchaste"
        >
          🧹 Liberar escuchados (${completedDlCount})
        </button>
      `
          : ''
      }

      ${
        dlCount > 0
          ? `
        <button class="btn btn-danger-outline" onclick="removeOfflineBookAudio('${b.id}')" title="Borrar todos los audios descargados del teléfono">
          🗑️ Liberar todo (${dlMB} MB)
        </button>
      `
          : ''
      }
    </div>
  `;

  // Renderizar lista de capítulos con los 4 estados visuales y botones de marcado rápido
  const listEl = document.getElementById('chaptersList');
  const filteredChapters = chapters.filter((ch) => {
    const isDl = dlSet.has(ch.id);
    const chProg = getSavedChapterProgress(b.id, ch.id);
    const isComp = Boolean(chProg && chProg.completed);
    const hasPartial = Boolean(chProg && (chProg.position_sec || 0) > 2);

    if (chapterFilter === 'unplayed') return !isComp;
    if (chapterFilter === 'listened') return isComp;
    if (chapterFilter === 'in_progress') return hasPartial || (stats.isStarted && ch.id === resumeChId && !isComp);
    if (chapterFilter === 'ready') return ch.status === 'ready' || isDl;
    if (chapterFilter === 'offline') return isDl;
    return true;
  });

  listEl.innerHTML = filteredChapters
    .map((ch) => {
      const isDl = dlSet.has(ch.id);
      const isPlayable = isDl || (isServerOnline && ch.status === 'ready');
      const isPlayingThis = isPlayerLoaded && currentPlayingBookId === b.id && currentPlayingChapterId === ch.id;
      const chProg = getSavedChapterProgress(b.id, ch.id);
      const savedPosSec =
        isPlayingThis && !isRestoringSeek && audio.currentTime > 0
          ? audio.currentTime
          : chProg
          ? chProg.position_sec
          : 0;
      const estChDurSec =
        (chProg && chProg.duration_sec) || ((ch.actual_min || ch.duration_min || 0) * 60);
      const chPct =
        estChDurSec > 0 && savedPosSec > 2 ? Math.min(100, Math.round((savedPosSec / estChDurSec) * 100)) : 0;
      const isCompletedCh = Boolean(chProg && chProg.completed);
      const isBookmarkCh = stats.isStarted && ch.id === resumeChId && !stats.isAllListened;
      const isPartialCh = !isCompletedCh && savedPosSec > 2;

      let statusHtml = '';
      if (isPlayingThis) {
        statusHtml = `<span class="badge audible">${audio.paused ? '⏸ En pausa' : '🔊 Escuchando ahora'}${
          isCompletedCh ? ' • ✓ Ya escuchado' : ''
        }</span>`;
      } else if (isBookmarkCh) {
        statusHtml = `<span class="badge audible">📍 QUEDASTE AQUÍ${
          savedPosSec > 2 ? ` (${formatTime(savedPosSec)})` : ''
        }</span>`;
      } else if (isCompletedCh) {
        statusHtml = `<span class="badge offline">✅ Ya escuchado${
          savedPosSec > 2 ? ` • 🔄 En ${formatTime(savedPosSec)}` : ''
        }</span>`;
      } else if (isPartialCh) {
        statusHtml = `<span class="badge audible">⏳ A mitad (${chPct}%)</span>`;
      } else if (isDl) {
        statusHtml = `<span class="badge pdf">⚪ Sin escuchar • 📱</span>`;
      } else if (ch.status === 'ready') {
        statusHtml = `<span class="badge" style="background: rgba(148,163,184,0.14); color: var(--text-secondary);">⚪ Por escuchar</span>`;
      } else if (ch.status === 'processing') {
        statusHtml = `<span class="badge pdf">⏳ ${escapeHtml(ch.step_detail || 'Traduciendo')} (${ch.step_pct || 0}%)</span>`;
      } else {
        statusHtml = `<span class="badge" style="background: rgba(148,163,184,0.12); color: var(--muted);">En cola PC</span>`;
      }

      const durText = ch.actual_min
        ? `${ch.actual_min} min`
        : ch.duration_min
        ? `~${ch.duration_min} min`
        : '';

      const progressRowHtml =
        savedPosSec > 2
          ? `
            <div class="ch-progress-wrap">
              <div class="ch-progress-track">
                <div class="ch-progress-fill" style="width: ${chPct}%;"></div>
              </div>
              <span class="ch-progress-label">⏱ Quedaste en ${formatTime(savedPosSec)}${
              estChDurSec > 0 ? ` de ${formatTime(estChDurSec)} (${chPct}%)` : ''
            }</span>
            </div>
          `
          : isCompletedCh
          ? `
            <div class="ch-progress-wrap">
              <div class="ch-progress-track">
                <div class="ch-progress-fill" style="width: 100%; background: var(--emerald);"></div>
              </div>
              <span class="ch-progress-label" style="color: #34d399;">✓ Capítulo completado (toca para volver a escuchar desde 00:00)</span>
            </div>
          `
          : '';

      const showBatchMarkUpToHere =
        ch.id > 1 &&
        !isCompletedCh &&
        (isBookmarkCh || isPlayingThis || isPartialCh);

      const rowClasses = [
        'chapter-row',
        isPlayable ? 'ready' : 'pending',
        isPlayingThis ? 'playing' : '',
        isBookmarkCh ? 'current-bookmark' : '',
        isCompletedCh ? 'completed-ch' : '',
        isPartialCh ? 'partial-ch' : '',
      ]
        .filter(Boolean)
        .join(' ');

      const numBoxClass = isCompletedCh ? 'ch-num done' : isBookmarkCh ? 'ch-num bookmark' : 'ch-num';
      const numBoxLabel = isCompletedCh ? '✓' : isBookmarkCh ? '📍' : ch.id;

      return `
        <div
          class="${rowClasses}"
          onclick="${isPlayable ? `playChapter('${b.id}', ${ch.id}, true)` : ''}"
        >
          <div class="ch-left">
            <div class="${numBoxClass}">${numBoxLabel}</div>
            <div class="ch-info">
              <div class="ch-title-es">Cap. ${ch.id}: ${escapeHtml(ch.title_es)}</div>
              ${
                ch.title_en && ch.title_en !== ch.title_es
                  ? `<div class="ch-title-en">${escapeHtml(ch.title_en)}</div>`
                  : ''
              }
              ${ch.preview_es ? `<div class="ch-preview">${escapeHtml(ch.preview_es)}</div>` : ''}
              ${progressRowHtml}
            </div>
          </div>
          <div class="ch-right">
            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 5px;">
              <span style="font-size: 0.74rem; color: var(--muted); font-weight: 700;">${durText}</span>
              ${statusHtml}
              ${
                showBatchMarkUpToHere
                  ? `<button
                      type="button"
                      class="ch-batch-btn"
                      onclick="event.stopPropagation(); markPreviousChaptersListened('${b.id}', ${ch.id - 1})"
                      title="Marcar capítulos 1 al ${ch.id - 1} como ya escuchados"
                    >
                      ✓ Marcar 1..${ch.id - 1} escuchados
                    </button>`
                  : ''
              }
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              <button
                type="button"
                class="ch-check-btn ${isCompletedCh ? 'done' : ''}"
                onclick="event.stopPropagation(); toggleChapterListenedStatus('${b.id}', ${ch.id})"
                title="${isCompletedCh ? 'Marcado como escuchado (toca para desmarcar)' : 'Marcar capítulo como ya escuchado'}"
              >
                ✓
              </button>
              ${
                ch.status === 'ready' || isDl
                  ? `
                <button
                  type="button"
                  class="dl-icon-btn ${isDl ? 'downloaded' : ''}"
                  onclick="event.stopPropagation(); toggleSingleChapterOffline('${b.id}', ${ch.id})"
                  title="${isDl ? 'Guardado en el teléfono (toca para borrar)' : 'Descargar capítulo al teléfono'}"
                >
                  ${isDl ? '📱' : '⬇'}
                </button>
              `
                  : ''
              }
            </div>
          </div>
        </div>
      `;
    })
    .join('');
}

// --- DESCARGA OFFLINE A INDEXEDDB (TELÉFONO) ---
async function fetchCoverAsDataUrl(book) {
  if (!book.cover_url) return null;
  try {
    const res = await fetch(apiUrl(book.cover_url));
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch (_) {
    return null;
  }
}

async function fetchChapterSpanishText(bookId, chapterId, fallbackPreview = '') {
  if (!isServerOnline) return fallbackPreview || '';
  try {
    const res = await fetch(apiUrl(`/api/books/${bookId}/chapter/${chapterId}/text`));
    if (!res.ok) return fallbackPreview || '';
    const data = await res.json();
    return data.text_es || fallbackPreview || '';
  } catch (_) {
    return fallbackPreview || '';
  }
}

async function downloadFullBookOffline(bookId) {
  const book = getBookById(bookId);
  if (!book) return;

  await window.offlineDB.requestPersistentStorage();
  const coverData = await fetchCoverAsDataUrl(book);
  await window.offlineDB.saveBookMetadata(book, coverData);

  const readyChs = (book.chapters || []).filter((c) => c.status === 'ready');
  if (readyChs.length === 0) {
    showToast('Aún no hay capítulos listos para descargar.');
    return;
  }

  const dlCard = document.getElementById('offlineDownloadCard');
  const dlStatus = document.getElementById('offlineDlStatus');
  const dlPct = document.getElementById('offlineDlPct');
  const dlFill = document.getElementById('offlineDlFill');
  if (dlCard) dlCard.style.display = 'block';

  let doneCount = 0;

  for (const ch of readyChs) {
    doneCount++;
    const pct = Math.round((doneCount / readyChs.length) * 100);
    if (dlStatus) dlStatus.textContent = `⬇ Descargando al teléfono: Cap. ${ch.id} (${doneCount}/${readyChs.length})...`;
    if (dlPct) dlPct.textContent = `${pct}%`;
    if (dlFill) dlFill.style.width = `${pct}%`;

    const existingRec = await window.offlineDB.getChapterAudio(bookId, ch.id);
    if (existingRec && existingRec.blob && (!ch.audio_mtime || existingRec.audio_mtime === ch.audio_mtime)) {
      // Si el MP3 ya estaba descargado pero faltaba guardar el texto completo en español para lectura offline
      if (!existingRec.text_es || existingRec.text_es.length < 120) {
        const textEs = await fetchChapterSpanishText(bookId, ch.id, ch.preview_es);
        if (textEs) {
          await window.offlineDB.saveChapterAudio(bookId, ch, existingRec.blob, textEs);
        }
      }
      continue;
    }

    try {
      const [audioRes, textEs] = await Promise.all([
        fetch(apiUrl(ch.audio_url)),
        fetchChapterSpanishText(bookId, ch.id, ch.preview_es),
      ]);
      if (!audioRes.ok) throw new Error(`HTTP ${audioRes.status}`);
      const mp3Blob = await audioRes.blob();
      await window.offlineDB.saveChapterAudio(bookId, ch, mp3Blob, textEs);
    } catch (e) {
      console.error('Error descargando capítulo', ch.id, e);
      showToast(`⚠️ Error descargando Cap. ${ch.id}: verifica la conexión con tu PC`);
      break;
    }
  }

  if (dlCard) {
    setTimeout(() => {
      dlCard.style.display = 'none';
    }, 1500);
  }
  await refreshLocalStorageState();
  updateHeaderStatus();
  renderCurrentView();
  showToast('✅ ¡Audio y texto en español guardados en tu teléfono para usar 100% offline!');
}

async function toggleSingleChapterOffline(bookId, chapterId) {
  const book = getBookById(bookId);
  if (!book) return;
  const ch = (book.chapters || []).find((c) => c.id === chapterId);
  if (!ch) return;

  const existingIds = await window.offlineDB.getDownloadedChapterIdsForBook(bookId);
  if (existingIds.has(chapterId)) {
    await window.offlineDB.deleteChapterAudio(bookId, chapterId);
    await refreshLocalStorageState();
    updateHeaderStatus();
    renderCurrentView();
    showToast(`🗑️ Capítulo ${chapterId} eliminado de la memoria del teléfono.`);
    return;
  }

  if (!isServerOnline) {
    showToast('⚠️ Conéctate a la PC para descargar este capítulo.');
    return;
  }

  showToast(`⬇ Descargando Cap. ${chapterId} (audio + texto ES) al teléfono...`);
  try {
    await window.offlineDB.requestPersistentStorage();
    const coverData = await fetchCoverAsDataUrl(book);
    await window.offlineDB.saveBookMetadata(book, coverData);

    const [res, textEs] = await Promise.all([
      fetch(apiUrl(ch.audio_url)),
      fetchChapterSpanishText(bookId, ch.id, ch.preview_es),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    await window.offlineDB.saveChapterAudio(bookId, ch, blob, textEs);

    await refreshLocalStorageState();
    updateHeaderStatus();
    renderCurrentView();
    showToast(`📱 Capítulo ${chapterId} (audio + texto) guardado offline en tu teléfono.`);
  } catch (e) {
    showToast(`⚠️ No se pudo descargar el capítulo ${chapterId}.`);
  }
}

async function removeOfflineBookAudio(bookId) {
  await window.offlineDB.deleteAllBookAudio(bookId);
  await refreshLocalStorageState();
  updateHeaderStatus();
  renderCurrentView();
  showToast('🗑️ Espacio offline liberado en tu teléfono.');
}

// --- PROGRESO POR LIBRO Y CAPÍTULO + REPRODUCTOR ANDROID MEDIA SESSION ---
function getSavedChapterProgress(bookId, chapterId) {
  if (!bookId || !chapterId) return null;
  const pb = playbackStates[bookId];
  if (!pb) return null;
  const chRec = pb.chapters ? pb.chapters[String(chapterId)] : null;
  if (chRec) {
    return {
      position_sec: Number(chRec.position_sec || 0),
      duration_sec: Number(chRec.duration_sec || 0),
      completed: Boolean(chRec.completed),
      updated_at: Number(chRec.updated_at || pb.updated_at || 0),
    };
  }
  if (pb.chapter_id === chapterId) {
    return {
      position_sec: Number(pb.position_sec || 0),
      duration_sec: Number(pb.duration_sec || 0),
      completed: false,
      updated_at: Number(pb.updated_at || 0),
    };
  }
  return null;
}

function pushProgressToServer(bookState, useBeacon = false) {
  if (!bookState || !bookState.book_id) return;
  const payload = JSON.stringify({
    ...bookState,
    last_active_book_id: bookState.book_id,
    force_active: true,
  });

  if (useBeacon && navigator.sendBeacon && isServerOnline && navigator.onLine && getServerBaseUrl()) {
    try {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(apiUrl('/api/progress'), blob);
      return;
    } catch (_) {}
  }

  if (!isServerOnline || !navigator.onLine || !getServerBaseUrl()) return;
  const targetTs = Number(bookState.updated_at || Date.now());
  fetch(apiUrl('/api/progress'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  })
    .then((res) => {
      if (res.ok) {
        window.offlineDB.clearBookDirtySync(bookState.book_id, targetTs);
        updateHeaderStatus();
      }
    })
    .catch(() => {});
}

function persistCurrentProgress({
  immediateServer = false,
  useBeacon = false,
  completed = false,
  pausedNow = false,
  playingNow = false,
} = {}) {
  if (!currentPlayingBookId || !currentPlayingChapterId || !isPlayerLoaded) return;

  let curSec = 0;
  if (completed) {
    curSec = 0;
  } else if (pendingSeekSec !== null && isRestoringSeek) {
    curSec = pendingSeekSec;
  } else {
    curSec = audio.currentTime || 0;
  }

  const durSec = audio.duration && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  // Escritura 100% síncrona a localStorage + cola serializada a IndexedDB (cero condiciones de carrera)
  const mirrorRec = window.offlineDB.savePlaybackMirrorSync(
    currentPlayingBookId,
    currentPlayingChapterId,
    curSec,
    durSec,
    currentPlaybackRate,
    completed,
    {
      paused_now: pausedNow,
      playing_now: playingNow,
    }
  );
  playbackStates[currentPlayingBookId] = mirrorRec;

  if (!isServerOnline) {
    updateHeaderStatus();
  }

  const now = Date.now();
  if (useBeacon || immediateServer || now - lastServerProgressSyncMs >= 8000) {
    lastServerProgressSyncMs = now;
    pushProgressToServer(mirrorRec, useBeacon);
  }
}

function updatePlayerProgressUI(posSec, durSec) {
  const safePos = Math.max(0, Number(posSec) || 0);
  const safeDur = Math.max(0, Number(durSec) || 0);
  const pct = safeDur > 0 ? Math.min(100, Math.max(0, (safePos / safeDur) * 100)) : 0;
  document.getElementById('mpProgressFill').style.width = `${pct}%`;
  document.getElementById('fpScrubber').value = String(pct);
  document.getElementById('fpCurrentTime').textContent = formatTime(safePos);
  const remEl = document.getElementById('fpRemainingInfo');
  if (safeDur > 0) {
    document.getElementById('fpDuration').textContent = formatTime(safeDur);
    if (remEl) {
      const rate = currentPlaybackRate > 0 ? currentPlaybackRate : 1.0;
      const remRealSec = Math.max(0, (safeDur - safePos) / rate);
      const remMin = Math.ceil(remRealSec / 60);
      remEl.textContent =
        remRealSec <= 5
          ? '✓ Finalizando capítulo'
          : `⏱ Restan ~${remMin} min reales a ${rate}x`;
    }
  } else if (remEl) {
    remEl.textContent = '';
  }
}

function applyPendingSeek() {
  if (pendingSeekSec === null) return;
  const dur = audio.duration;
  if (!dur || !isFinite(dur) || dur <= 0) return;

  const target = Math.max(0, Math.min(pendingSeekSec, Math.max(0, dur - 1.5)));
  pendingSeekSec = null;
  try {
    audio.currentTime = target;
  } catch (_) {}
  isRestoringSeek = false;
  lastSavedSec = target;
  updatePlayerProgressUI(target, dur);
  updateMediaSessionPosition();
}

function computeSmartRewindSeconds(lastPausedAtMs) {
  const ts = Number(lastPausedAtMs || 0);
  if (!ts || ts <= 0) return 0;
  const idleSec = (Date.now() - ts) / 1000;
  if (idleSec < 45) return 0;
  if (idleSec < 600) return 2.5; // 45s a 10 min -> retrocede 2.5s
  if (idleSec < 7200) return 4.5; // 10 min a 2 horas -> retrocede 4.5s
  return 7.0; // Más de 2 horas (ej. al día siguiente) -> retrocede 7s para retomar el hilo
}

async function attachAudioSourceForChapter(bookId, chapterId) {
  const book = getBookById(bookId);
  if (!book) return null;
  const ch = (book.chapters || []).find((c) => c.id === chapterId);
  if (!ch) return null;

  let offlineRec = await window.offlineDB.getChapterAudio(bookId, chapterId);
  let playingFromOffline = false;

  const isOfflineStale =
    isServerOnline &&
    ch.status === 'ready' &&
    offlineRec &&
    ch.audio_mtime &&
    offlineRec.audio_mtime !== ch.audio_mtime;

  if (isOfflineStale) {
    Promise.all([
      fetch(apiUrl(ch.audio_url)).then((r) => (r.ok ? r.blob() : null)),
      fetchChapterSpanishText(bookId, ch.id, ch.preview_es),
    ])
      .then(([b, textEs]) => {
        if (b) {
          window.offlineDB
            .saveChapterAudio(bookId, ch, b, textEs)
            .then(() => refreshLocalStorageState());
        }
      })
      .catch(() => {});
    offlineRec = null;
  }

  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }

  if (offlineRec && offlineRec.blob) {
    currentObjectUrl = URL.createObjectURL(offlineRec.blob);
    audio.src = currentObjectUrl;
    playingFromOffline = true;
  } else if (isServerOnline && ch.status === 'ready') {
    audio.src = apiUrl(ch.audio_url);
    playingFromOffline = false;
  } else {
    return null;
  }

  audio.playbackRate = currentPlaybackRate;
  return { book, ch, playingFromOffline };
}

async function playChapter(bookId, chapterId, autoPlay = true, forceRestart = false) {
  if (autoPlay) {
    hasUserInteracted = true;
  }

  // Si ya estaba reproduciendo otro capítulo en esta sesión, guardar primero su segundo exacto antes de cambiar
  if (
    isPlayerLoaded &&
    audio.src &&
    currentPlayingBookId &&
    currentPlayingChapterId &&
    (currentPlayingBookId !== bookId || currentPlayingChapterId !== chapterId)
  ) {
    persistCurrentProgress({ immediateServer: true, pausedNow: true });
  }

  // Si el usuario toca el mismo capítulo que ya está cargado en memoria y no pide reiniciar, solo alternar Play
  if (
    isPlayerLoaded &&
    audio.src &&
    !audio.error &&
    currentPlayingBookId === bookId &&
    currentPlayingChapterId === chapterId &&
    !forceRestart
  ) {
    if (autoPlay && audio.paused) {
      await resumeFromMediaSession();
    }
    renderCurrentView();
    return;
  }

  // Consultar progreso síncrono inmediato en memoria/localStorage
  playbackStates = {
    ...playbackStates,
    ...window.offlineDB.getAllPlaybackStatesSync(),
  };
  const pb = playbackStates[bookId] || null;
  const savedCh = !forceRestart ? getSavedChapterProgress(bookId, chapterId) : null;
  const bookObj = getBookById(bookId);
  const chObj = bookObj ? (bookObj.chapters || []).find((c) => c.id === chapterId) : null;
  const estDurSec =
    (savedCh && savedCh.duration_sec) ||
    (chObj ? (chObj.actual_min || chObj.duration_min || 0) * 60 : 0);

  let resumeSec = 0;
  let appliedRewind = 0;
  if (savedCh && savedCh.position_sec > 2) {
    if (!estDurSec || savedCh.position_sec < estDurSec - 3) {
      resumeSec = savedCh.position_sec;
      if (autoPlay && resumeSec > 6) {
        const refTs =
          pb && pb.chapter_id === chapterId && pb.last_paused_at
            ? pb.last_paused_at
            : savedCh.updated_at || 0;
        appliedRewind = computeSmartRewindSeconds(refTs);
        if (appliedRewind > 0) {
          resumeSec = Math.max(0, resumeSec - appliedRewind);
        }
      }
    }
  }

  pendingSeekSec = resumeSec > 0 ? resumeSec : null;
  isRestoringSeek = pendingSeekSec !== null;

  const attached = await attachAudioSourceForChapter(bookId, chapterId);
  if (!attached) {
    pendingSeekSec = null;
    isRestoringSeek = false;
    showToast('⚠️ Este capítulo no está descargado en el teléfono y la PC está desconectada.');
    return;
  }

  const { book, ch, playingFromOffline } = attached;
  isPlayerLoaded = true;
  currentPlayingBookId = bookId;
  currentPlayingChapterId = chapterId;
  localStorage.setItem('melo_last_book_id', bookId);
  localStorage.setItem('melo_last_ch_id', String(chapterId));

  // Guardar este capítulo como el capítulo activo del libro conservando su posición exacta
  lastSavedSec = resumeSec;
  persistCurrentProgress({ immediateServer: autoPlay, playingNow: autoPlay });

  // Si los metadatos ya están listos (ej. Blob offline), aplicar el salto inmediatamente
  if (audio.readyState >= 1) {
    applyPendingSeek();
  } else {
    updatePlayerProgressUI(resumeSec, estDurSec);
  }

  // Actualizar UI del mini-player y full-player
  const coverSrc = getBookCoverSrc(book);
  document.getElementById('miniPlayer').style.display = 'block';
  document.getElementById('mpCover').src = coverSrc;
  document.getElementById('mpChapterTitle').textContent = `Cap. ${ch.id}: ${ch.title_es}`;
  document.getElementById('mpBookSubtitle').textContent = `${book.book_title_es} • ${
    playingFromOffline ? '📱 Offline' : '☁️ Streaming PC'
  }`;

  document.getElementById('fpCover').src = coverSrc;
  document.getElementById('fpChapterTitle').textContent = `Cap. ${ch.id}: ${ch.title_es}`;
  document.getElementById('fpBookTitle').textContent = `${book.book_title_es} (${book.author || ''})`;
  const fpBadge = document.getElementById('fpOfflineBadge');
  fpBadge.textContent = playingFromOffline ? '📱 Reproduciendo Offline (Teléfono)' : '☁️ Streaming desde PC';
  syncSpeedPillsUI();
  updatePlayerBookmarksBadge();

  const bmBox = document.getElementById('fpBookmarksBox');
  if (bmBox && bmBox.style.display !== 'none') {
    renderPlayerBookmarksBox();
  }

  const trBox = document.getElementById('fpTranscriptBox');
  if (trBox.style.display !== 'none') {
    loadChapterText(bookId, chapterId);
  }

  setupMediaSession(book, ch, coverSrc);
  renderCurrentView();

  if (autoPlay) {
    try {
      await audio.play();
      if (resumeSec > 5) {
        const rwHint = appliedRewind > 0 ? ` (↺ -${Math.round(appliedRewind)}s contexto)` : '';
        showToast(`▶ Reanudando Cap. ${ch.id} en ${formatTime(resumeSec)}${rwHint}`, 2500);
      }
    } catch (_) {}
  }
}

async function restartCurrentChapter() {
  if (!currentPlayingBookId || !currentPlayingChapterId) return;
  pendingSeekSec = null;
  isRestoringSeek = false;
  if (audio.src && !audio.error) {
    audio.currentTime = 0;
    lastSavedSec = 0;
    persistCurrentProgress({ immediateServer: true, playingNow: !audio.paused });
    updatePlayerProgressUI(0, audio.duration || 0);
    updateMediaSessionPosition();
    if (audio.paused) {
      audio.play().catch(() => {});
    }
    showToast('↺ Capítulo reiniciado desde 00:00', 2200);
    renderCurrentView();
  } else {
    await playChapter(currentPlayingBookId, currentPlayingChapterId, true, true);
  }
}

async function restoreLastPlayerSession() {
  const allBooks = getMergedBooks();
  if (allBooks.length === 0) return;

  // Prioridad: 1) Libro con updated_at más reciente entre local y servidor, 2) localStorage, 3) primer libro
  let bestBookId = currentPlayingBookId || serverLastActiveBookId;
  let newestTs = bestBookId && playbackStates[bestBookId] ? Number(playbackStates[bestBookId].updated_at || 0) : 0;

  for (const [bId, st] of Object.entries(playbackStates)) {
    const ts = Number((st && st.updated_at) || 0);
    if (ts > newestTs && allBooks.some((b) => b.id === bId)) {
      newestTs = ts;
      bestBookId = bId;
    }
  }

  const book = allBooks.find((b) => b.id === bestBookId) || allBooks[0];
  const pb = playbackStates[book.id];
  if (pb && pb.playback_rate && pb.playback_rate > 0) {
    currentPlaybackRate = Number(pb.playback_rate);
    localStorage.setItem('melo_playback_rate', String(currentPlaybackRate));
    syncSpeedPillsUI();
  }

  const targetChId = pb ? pb.chapter_id : currentPlayingBookId === book.id ? currentPlayingChapterId : 1;
  const dlSet = downloadedStats.byBook[book.id] ? downloadedStats.byBook[book.id].chapters : new Set();
  const chapters = book.chapters || [];
  const ch =
    chapters.find((c) => c.id === targetChId && (dlSet.has(c.id) || (isServerOnline && c.status === 'ready'))) ||
    chapters.find((c) => dlSet.has(c.id) || (isServerOnline && c.status === 'ready'));

  if (ch) {
    await playChapter(book.id, ch.id, false);
  }
}

function buildMediaSessionArtwork(coverSrc) {
  const artwork = [];
  if (mediaArtworkObjectUrl) {
    URL.revokeObjectURL(mediaArtworkObjectUrl);
    mediaArtworkObjectUrl = null;
  }

  // Si la portada está en base64 (modo offline), convertirla a un Blob URL nativo para que Android la pinte en pantalla de bloqueo
  if (coverSrc && coverSrc.startsWith('data:image/')) {
    try {
      const parts = coverSrc.split(',');
      const mimeMatch = parts[0].match(/data:(image\/[a-zA-Z0-9+.-]+);base64/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      const bin = atob(parts[1]);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      mediaArtworkObjectUrl = URL.createObjectURL(new Blob([arr], { type: mime }));
      artwork.push({ src: mediaArtworkObjectUrl, sizes: '512x512', type: mime });
    } catch (_) {}
  } else if (coverSrc && !coverSrc.endsWith('.svg')) {
    try {
      const absCover = new URL(coverSrc, window.location.href).href;
      artwork.push({ src: absCover, sizes: '512x512', type: 'image/jpeg' });
    } catch (_) {}
  }

  // Iconos PNG relativos a window.location.href (compatible con GitHub Pages /melo-audible/ y con origen raíz)
  const icon192 = new URL('./icons/icon-192.png', window.location.href).href;
  const icon512 = new URL('./icons/icon-512.png', window.location.href).href;
  artwork.push({ src: icon512, sizes: '512x512', type: 'image/png' });
  artwork.push({ src: icon192, sizes: '192x192', type: 'image/png' });
  return artwork;
}

function updateMediaSessionPosition() {
  if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
  const dur = audio.duration;
  if (!dur || !isFinite(dur) || dur <= 0) return;
  const rawPos = pendingSeekSec !== null && isRestoringSeek ? pendingSeekSec : audio.currentTime || 0;
  const pos = Math.max(0, Math.min(dur, rawPos));
  try {
    navigator.mediaSession.setPositionState({
      duration: dur,
      playbackRate: audio.playbackRate || 1.0,
      position: pos,
    });
  } catch (_) {}
}

async function resumeFromMediaSession() {
  if (!currentPlayingBookId || !currentPlayingChapterId) return;
  hasUserInteracted = true;

  // Auto-Rewind inteligente cuando el audiolibro estuvo pausado un buen rato (45s+ -> -2.5s a -7s)
  const pb = playbackStates[currentPlayingBookId];
  const rewindSec = computeSmartRewindSeconds(pb ? pb.last_paused_at : 0);

  // Recordar el segundo exacto por si el stream HTTP de Cloudflare caducó mientras estaba en pausa en segundo plano
  const savedCh = getSavedChapterProgress(currentPlayingBookId, currentPlayingChapterId);
  let fallbackSec =
    pendingSeekSec !== null
      ? pendingSeekSec
      : audio.currentTime > 1
      ? audio.currentTime
      : savedCh
      ? savedCh.position_sec
      : 0;

  if (rewindSec > 0 && fallbackSec > 6) {
    fallbackSec = Math.max(0, fallbackSec - rewindSec);
    if (audio.src && !audio.error && audio.readyState >= 1 && pendingSeekSec === null) {
      try {
        audio.currentTime = fallbackSec;
      } catch (_) {}
    } else if (pendingSeekSec !== null) {
      pendingSeekSec = fallbackSec;
    }
  }

  try {
    if (!audio.src || audio.error || audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
      pendingSeekSec = fallbackSec > 1 ? fallbackSec : null;
      isRestoringSeek = pendingSeekSec !== null;
      await attachAudioSourceForChapter(currentPlayingBookId, currentPlayingChapterId);
    }
    await audio.play();
    persistCurrentProgress({ immediateServer: false, playingNow: true });
    if (rewindSec >= 4 && fallbackSec > 3) {
      showToast(`↺ Reanudando con -${Math.round(rewindSec)}s para retomar el hilo`, 2200);
    }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
    updateMediaSessionPosition();
  } catch (_) {
    // Segundo intento: recargar la fuente desde IndexedDB o servidor y saltar al segundo guardado
    try {
      pendingSeekSec = fallbackSec > 1 ? fallbackSec : null;
      isRestoringSeek = pendingSeekSec !== null;
      const reattached = await attachAudioSourceForChapter(currentPlayingBookId, currentPlayingChapterId);
      if (reattached) {
        await audio.play();
        persistCurrentProgress({ immediateServer: false, playingNow: true });
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
        updateMediaSessionPosition();
      }
    } catch (err2) {
      console.warn('No se pudo reanudar audio desde segundo plano:', err2);
    }
  }
}

function pauseFromMediaSession() {
  audio.pause();
  if ('mediaSession' in navigator) {
    // Crítico en Android Chromium: mantener playbackState = 'paused' evita que MediaSessionImpl::IsControllable()
    // pase a false tras el idle timeout de WebMediaPlayerImpl y mantiene fijo el reproductor en pantalla de bloqueo.
    navigator.mediaSession.playbackState = 'paused';
  }
  updateMediaSessionPosition();
  persistCurrentProgress({ immediateServer: true, pausedNow: true });
}

function registerMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  const handlers = [
    ['play', () => resumeFromMediaSession()],
    ['pause', () => pauseFromMediaSession()],
    ['seekbackward', (details) => skipSeconds(-(details && details.seekOffset ? details.seekOffset : 15))],
    ['seekforward', (details) => skipSeconds(details && details.seekOffset ? details.seekOffset : 15)],
    [
      'seekto',
      (details) => {
        if (!audio.src || !details || details.seekTime == null) return;
        pendingSeekSec = null;
        isRestoringSeek = false;
        if (details.fastSeek && 'fastSeek' in audio) {
          audio.fastSeek(details.seekTime);
        } else {
          audio.currentTime = details.seekTime;
        }
        updateMediaSessionPosition();
        persistCurrentProgress({ immediateServer: true });
      },
    ],
    ['previoustrack', () => prevChapter()],
    ['nexttrack', () => nextChapter()],
  ];

  for (const [action, fn] of handlers) {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch (_) {}
  }
}

function setupMediaSession(book, ch, coverSrc) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `Cap. ${ch.id}: ${ch.title_es}`,
      artist: book.author || 'MeloAudible',
      album: book.book_title_es,
      artwork: buildMediaSessionArtwork(coverSrc),
    });
    navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  } catch (_) {}
  registerMediaSessionHandlers();
  updateMediaSessionPosition();
}

function togglePlay() {
  if (!audio.src && currentPlayingBookId) {
    playChapter(currentPlayingBookId, currentPlayingChapterId || 1, true);
    return;
  }
  if (audio.paused) {
    resumeFromMediaSession();
  } else {
    pauseFromMediaSession();
  }
}

function skipSeconds(sec) {
  if (!audio.src) return;
  pendingSeekSec = null;
  isRestoringSeek = false;
  const maxDur = audio.duration && isFinite(audio.duration) ? audio.duration : Infinity;
  audio.currentTime = Math.max(0, Math.min(maxDur, (audio.currentTime || 0) + sec));
  updateMediaSessionPosition();
  persistCurrentProgress({ immediateServer: true });
}

function syncSpeedPillsUI() {
  document.querySelectorAll('.sp-pill').forEach((b) => {
    const val = parseFloat(b.textContent.replace('x', ''));
    b.classList.toggle('active', Math.abs(val - currentPlaybackRate) < 0.01);
  });
}

function setPlaybackRate(rate, btn) {
  currentPlaybackRate = rate;
  localStorage.setItem('melo_playback_rate', String(rate));
  audio.playbackRate = rate;
  if (btn) {
    document.querySelectorAll('.sp-pill').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  } else {
    syncSpeedPillsUI();
  }
  if (audio.duration && isFinite(audio.duration)) {
    updatePlayerProgressUI(audio.currentTime || 0, audio.duration);
  }
  updateMediaSessionPosition();
  persistCurrentProgress({ immediateServer: true });
  renderCurrentView();
}

function nextChapter() {
  const book = getBookById(currentPlayingBookId);
  if (!book) return;
  const dlSet = downloadedStats.byBook[book.id] ? downloadedStats.byBook[book.id].chapters : new Set();
  const next = (book.chapters || []).find(
    (c) => c.id > currentPlayingChapterId && (dlSet.has(c.id) || (isServerOnline && c.status === 'ready'))
  );
  if (next) {
    playChapter(book.id, next.id, true);
  } else {
    showToast('Has llegado al último capítulo disponible.');
  }
}

function prevChapter() {
  const book = getBookById(currentPlayingBookId);
  if (!book) return;
  if (audio.currentTime > 10) {
    audio.currentTime = 0;
    updateMediaSessionPosition();
    persistCurrentProgress({ immediateServer: true });
    return;
  }
  const dlSet = downloadedStats.byBook[book.id] ? downloadedStats.byBook[book.id].chapters : new Set();
  const prev = [...(book.chapters || [])]
    .reverse()
    .find((c) => c.id < currentPlayingChapterId && (dlSet.has(c.id) || (isServerOnline && c.status === 'ready')));
  if (prev) {
    playChapter(book.id, prev.id, true);
  }
}

function openFullPlayer() {
  updatePlayerBookmarksBadge();
  document.getElementById('fullPlayerModal').classList.add('open');
}

function closeFullPlayer() {
  document.getElementById('fullPlayerModal').classList.remove('open');
}

function onScrubInput(pctVal) {
  if (!audio.duration || isNaN(audio.duration)) return;
  pendingSeekSec = null;
  isRestoringSeek = false;
  audio.currentTime = (parseFloat(pctVal) / 100) * audio.duration;
  updatePlayerProgressUI(audio.currentTime, audio.duration);
  updateMediaSessionPosition();
  persistCurrentProgress({ immediateServer: false });
}

function seekFromMiniBar(e) {
  if (!audio.duration || isNaN(audio.duration)) return;
  pendingSeekSec = null;
  isRestoringSeek = false;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.currentTime = ratio * audio.duration;
  updatePlayerProgressUI(audio.currentTime, audio.duration);
  updateMediaSessionPosition();
  persistCurrentProgress({ immediateServer: true });
}

function cycleSleepTimer() {
  const options = [0, 15, 30, 45, -1];
  const idx = options.indexOf(sleepTimerMinutes);
  sleepTimerMinutes = options[(idx + 1) % options.length];
  clearTimeout(sleepTimeoutId);

  const ind = document.getElementById('fpSleepIndicator');
  if (sleepTimerMinutes === 0) {
    ind.textContent = '';
    showToast('🌙 Temporizador de sueño desactivado');
  } else if (sleepTimerMinutes === -1) {
    ind.textContent = '🌙 Pausa al fin del capítulo';
    showToast('🌙 Se pausará al terminar este capítulo');
  } else {
    ind.textContent = `🌙 Sleep: ${sleepTimerMinutes} min`;
    showToast(`🌙 El audiolibro se pausará en ${sleepTimerMinutes} minutos`);
    sleepTimeoutId = setTimeout(() => {
      pauseFromMediaSession();
      sleepTimerMinutes = 0;
      ind.textContent = '';
    }, sleepTimerMinutes * 60 * 1000);
  }
}

async function toggleChapterTranscript() {
  const box = document.getElementById('fpTranscriptBox');
  if (box.style.display === 'none') {
    box.style.display = 'block';
    await loadChapterText(currentPlayingBookId, currentPlayingChapterId);
  } else {
    box.style.display = 'none';
  }
}

async function loadChapterText(bookId, chapterId) {
  const box = document.getElementById('fpTranscriptBox');
  if (!box || !bookId || !chapterId) return;
  const book = getBookById(bookId);
  const ch = book ? (book.chapters || []).find((c) => c.id === chapterId) : null;

  // 1. Intentar primero desde IndexedDB local (funciona 100% offline en < 5ms)
  try {
    const offlineRec = await window.offlineDB.getChapterAudio(bookId, chapterId);
    if (offlineRec && offlineRec.text_es && offlineRec.text_es.length > 80) {
      box.textContent = offlineRec.text_es;
      return;
    }
  } catch (_) {}

  if (!isServerOnline) {
    box.textContent =
      (ch && ch.preview_es) ||
      'Descarga este capítulo al teléfono con tu PC conectada para disponer del texto completo sin internet.';
    return;
  }

  try {
    box.textContent = 'Cargando texto en español...';
    const res = await fetch(apiUrl(`/api/books/${bookId}/chapter/${chapterId}/text`));
    const data = await res.json();
    const fullText = data.text_es || (ch && ch.preview_es) || 'Sin texto disponible.';
    box.textContent = fullText;

    // Si el capítulo ya tenía su MP3 guardado offline, enriquecerlo también con el texto completo
    if (data.text_es && ch) {
      const offlineRec = await window.offlineDB.getChapterAudio(bookId, chapterId);
      if (offlineRec && offlineRec.blob && (!offlineRec.text_es || offlineRec.text_es.length < 80)) {
        window.offlineDB.saveChapterAudio(bookId, ch, offlineRec.blob, data.text_es).catch(() => {});
      }
    }
  } catch (_) {
    box.textContent = (ch && ch.preview_es) || 'No se pudo cargar el texto.';
  }
}

// --- MARCADORES DE AUDIO Y CITAS RÁPIDAS (1 TOQUE) ---
function updatePlayerBookmarksBadge() {
  const badge = document.getElementById('fpBookmarksCount');
  if (!badge) return;
  const pb = currentPlayingBookId ? playbackStates[currentPlayingBookId] : null;
  const list = pb && Array.isArray(pb.bookmarks) ? pb.bookmarks : [];
  badge.textContent = String(list.length);
}

function extractApproximateChapterSnippet(fullText, posSec, durSec) {
  const clean = String(fullText || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length < 30) return '';
  if (!durSec || durSec <= 0) return clean.slice(0, 140) + (clean.length > 140 ? '…' : '');
  const ratio = Math.max(0, Math.min(0.97, posSec / durSec));
  const centerIdx = Math.floor(clean.length * ratio);
  const start = Math.max(0, clean.lastIndexOf(' ', Math.max(0, centerIdx - 55)));
  const snippet = clean.slice(start, start + 150).trim();
  return snippet ? (start > 0 ? '…' : '') + snippet + (start + 150 < clean.length ? '…' : '') : '';
}

async function saveQuickBookmarkFromPlayer() {
  if (!currentPlayingBookId || !currentPlayingChapterId) return;
  const book = getBookById(currentPlayingBookId);
  const ch = book ? (book.chapters || []).find((c) => c.id === currentPlayingChapterId) : null;
  const posSec = Math.max(0, Math.round(audio.currentTime || 0));
  const durSec = audio.duration && isFinite(audio.duration) ? audio.duration : 0;

  let sourceText = '';
  try {
    const offRec = await window.offlineDB.getChapterAudio(currentPlayingBookId, currentPlayingChapterId);
    if (offRec && offRec.text_es) sourceText = offRec.text_es;
  } catch (_) {}
  if (!sourceText && isServerOnline) {
    sourceText = await fetchChapterSpanishText(currentPlayingBookId, currentPlayingChapterId, ch ? ch.preview_es : '');
  }
  const snippet = extractApproximateChapterSnippet(sourceText || (ch && ch.preview_es) || '', posSec, durSec);

  const updated = await window.offlineDB.addAudioBookmark(currentPlayingBookId, {
    chapter_id: currentPlayingChapterId,
    chapter_title: ch ? ch.title_es : `Capítulo ${currentPlayingChapterId}`,
    position_sec: posSec,
    note: '',
    snippet,
  });
  playbackStates[currentPlayingBookId] = updated;
  pushProgressToServer(updated);
  updatePlayerBookmarksBadge();

  const bmBox = document.getElementById('fpBookmarksBox');
  if (bmBox) {
    bmBox.style.display = 'block';
    renderPlayerBookmarksBox();
  }
  renderCurrentView();
  showToast(`🔖 Marcador guardado en Cap. ${currentPlayingChapterId} (${formatTime(posSec)})`, 2600);
}

function togglePlayerBookmarksList() {
  const bmBox = document.getElementById('fpBookmarksBox');
  if (!bmBox) return;
  if (bmBox.style.display === 'none') {
    bmBox.style.display = 'block';
    renderPlayerBookmarksBox();
  } else {
    bmBox.style.display = 'none';
  }
}

function renderPlayerBookmarksBox() {
  const bmBox = document.getElementById('fpBookmarksBox');
  if (!bmBox || !currentPlayingBookId) return;
  const pb = playbackStates[currentPlayingBookId];
  const list = pb && Array.isArray(pb.bookmarks) ? pb.bookmarks : [];
  if (list.length === 0) {
    bmBox.innerHTML = `<div style="color: var(--muted); font-size: 0.8rem;">Aún no tienes citas o minutos guardados en este audiolibro. Toca <strong>🔖 Guardar Cita / Minuto</strong> en cualquier momento.</div>`;
    return;
  }

  bmBox.innerHTML = list
    .map(
      (bm) => `
      <div class="bookmark-card">
        <div style="flex: 1; min-width: 0; cursor: pointer;" onclick="jumpToAudioBookmark('${currentPlayingBookId}', ${bm.chapter_id}, ${bm.position_sec})">
          <div style="font-size: 0.78rem; font-weight: 800; color: #fbbf24;">
            ▶ Cap. ${bm.chapter_id} • ${formatTime(bm.position_sec)}${bm.note ? ` — ${escapeHtml(bm.note)}` : ''}
          </div>
          ${bm.snippet ? `<div style="font-size: 0.73rem; color: var(--text-secondary); margin-top: 2px;">"${escapeHtml(bm.snippet)}"</div>` : ''}
        </div>
        <div style="display: flex; gap: 4px; align-items: center;">
          <button class="close-sheet-btn" style="padding: 3px 7px; font-size: 0.7rem;" onclick="editAudioBookmarkNote('${currentPlayingBookId}', '${escapeHtml(bm.id)}')" title="Agregar o editar nota">✏️</button>
          <button class="close-sheet-btn" style="padding: 3px 7px; font-size: 0.7rem;" onclick="deleteAudioBookmark('${currentPlayingBookId}', '${escapeHtml(bm.id)}')" title="Eliminar marcador">✕</button>
        </div>
      </div>
    `
    )
    .join('');
}

async function editAudioBookmarkNote(bookId, bmId) {
  const pb = playbackStates[bookId];
  if (!pb || !Array.isArray(pb.bookmarks)) return;
  const target = pb.bookmarks.find((b) => b.id === bmId);
  if (!target) return;
  const nextNote = window.prompt('Escribe una nota corta para este momento del audiolibro:', target.note || '');
  if (nextNote === null) return;
  const nextBookmarks = pb.bookmarks.map((b) => (b.id === bmId ? { ...b, note: nextNote.trim() } : b));
  const updated = await window.offlineDB.savePlaybackState(bookId, {
    ...pb,
    bookmarks: nextBookmarks,
    replace_bookmarks: true,
    skip_direct_chapter_update: true,
    updated_at: Date.now(),
  });
  playbackStates[bookId] = updated;
  pushProgressToServer(updated);
  renderPlayerBookmarksBox();
  renderCurrentView();
}

async function jumpToAudioBookmark(bookId, chapterId, posSec) {
  const safePos = Math.max(0, Number(posSec) || 0);
  if (isPlayerLoaded && currentPlayingBookId === bookId && currentPlayingChapterId === chapterId && audio.src && !audio.error) {
    pendingSeekSec = null;
    isRestoringSeek = false;
    audio.currentTime = safePos;
    updatePlayerProgressUI(safePos, audio.duration || 0);
    updateMediaSessionPosition();
    persistCurrentProgress({ immediateServer: true, playingNow: true });
    if (audio.paused) {
      audio.play().catch(() => {});
    }
    showToast(`🔖 Saltando a ${formatTime(safePos)}`, 1800);
    return;
  }

  // Ajustar posición objetivo en el capítulo antes de reproducir
  const saved = window.offlineDB.savePlaybackMirrorSync(bookId, chapterId, safePos, 0, currentPlaybackRate, false, {
    playing_now: true,
  });
  playbackStates[bookId] = saved;
  await playChapter(bookId, chapterId, true, false);
}

async function deleteAudioBookmark(bookId, bmId) {
  const updated = await window.offlineDB.removeAudioBookmark(bookId, bmId);
  if (updated) {
    playbackStates[bookId] = updated;
    pushProgressToServer(updated);
  }
  updatePlayerBookmarksBadge();
  renderPlayerBookmarksBox();
  renderCurrentView();
  showToast('🗑️ Marcador eliminado', 1800);
}

// Eventos del elemento <audio>
audio.addEventListener('loadedmetadata', () => {
  audio.playbackRate = currentPlaybackRate;
  if (pendingSeekSec !== null) {
    applyPendingSeek();
  } else {
    updatePlayerProgressUI(audio.currentTime || 0, audio.duration || 0);
    updateMediaSessionPosition();
  }
});

audio.addEventListener('canplay', () => {
  if (pendingSeekSec !== null) {
    applyPendingSeek();
  }
});

audio.addEventListener('play', () => {
  lastActivityLogWallMs = Date.now();
  document.getElementById('mpPlayBtn').textContent = '⏸';
  document.getElementById('fpPlayBtn').textContent = '⏸ Pausar';
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing';
  }
  updateMediaSessionPosition();
  if (document.visibilityState !== 'hidden') {
    renderCurrentView();
  }
});

audio.addEventListener('pause', () => {
  lastActivityLogWallMs = 0;
  document.getElementById('mpPlayBtn').textContent = '▶';
  document.getElementById('fpPlayBtn').textContent = '▶ Reproducir';
  if ('mediaSession' in navigator && isPlayerLoaded) {
    navigator.mediaSession.playbackState = 'paused';
  }
  updateMediaSessionPosition();
  // No marcar como pausa en mitad de un final de pista natural (audio.ended)
  if (!audio.ended) {
    persistCurrentProgress({ immediateServer: true, pausedNow: true });
  }
  if (document.visibilityState !== 'hidden') {
    renderCurrentView();
  }
});

audio.addEventListener('seeked', () => {
  isRestoringSeek = false;
  updateMediaSessionPosition();
  persistCurrentProgress({ immediateServer: true });
});

audio.addEventListener('ratechange', () => {
  updateMediaSessionPosition();
});

let lastSavedSec = 0;
audio.addEventListener('timeupdate', () => {
  if (isRestoringSeek && pendingSeekSec !== null) return;

  const cur = audio.currentTime || 0;
  const dur = audio.duration || 0;
  if (dur > 0) {
    updatePlayerProgressUI(cur, dur);
  }

  const now = Date.now();
  // Registrar tiempo real de escucha en el historial diario local
  if (!audio.paused && currentPlayingBookId) {
    if (lastActivityLogWallMs > 0) {
      const wallDeltaSec = (now - lastActivityLogWallMs) / 1000;
      if (wallDeltaSec >= 4.0 && wallDeltaSec <= 30.0) {
        const bObj = getBookById(currentPlayingBookId);
        const cObj = bObj ? (bObj.chapters || []).find((c) => c.id === currentPlayingChapterId) : null;
        window.offlineDB.logListeningSecondsSync(
          currentPlayingBookId,
          bObj ? bObj.book_title_es : currentPlayingBookId,
          currentPlayingChapterId || 1,
          cObj ? cObj.title_es : `Capítulo ${currentPlayingChapterId || 1}`,
          wallDeltaSec
        );
        lastActivityLogWallMs = now;
      } else if (wallDeltaSec > 30.0) {
        lastActivityLogWallMs = now;
      }
    } else {
      lastActivityLogWallMs = now;
    }
  }

  if (now - lastMediaPositionUpdateMs >= 5000) {
    lastMediaPositionUpdateMs = now;
    updateMediaSessionPosition();
  }

  if (currentPlayingBookId && Math.abs(cur - lastSavedSec) >= 2.0) {
    lastSavedSec = cur;
    persistCurrentProgress({ immediateServer: false });
  }
});

audio.addEventListener('ended', async () => {
  lastActivityLogWallMs = 0;
  if (currentPlayingBookId) {
    persistCurrentProgress({ immediateServer: true, completed: true });
  }
  if (sleepTimerMinutes === -1) {
    sleepTimerMinutes = 0;
    document.getElementById('fpSleepIndicator').textContent = '';
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    return;
  }
  nextChapter();
});

// --- VISTA 2: SUBIR PDF E IMPORTAR AUDIBLE ---
function onPdfSelected(input) {
  if (input.files && input.files[0]) {
    selectedPdfFile = input.files[0];
    document.getElementById('pdfSelectedName').textContent = `📄 ${selectedPdfFile.name} (${(
      selectedPdfFile.size /
      (1024 * 1024)
    ).toFixed(1)} MB)`;
  }
}

const dropzone = document.getElementById('pdfDropzone');
if (dropzone) {
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      selectedPdfFile = e.dataTransfer.files[0];
      document.getElementById('pdfSelectedName').textContent = `📄 ${selectedPdfFile.name} (${(
        selectedPdfFile.size /
        (1024 * 1024)
      ).toFixed(1)} MB)`;
    }
  });
}

async function uploadAndStartPdf() {
  if (!selectedPdfFile) {
    showToast('⚠️ Primero selecciona un archivo PDF.');
    return;
  }
  if (!isServerOnline) {
    showToast('⚠️ Debes estar conectado a tu PC para procesar un nuevo PDF.');
    return;
  }

  const btn = document.getElementById('uploadPdfBtn');
  const title = document.getElementById('pdfTitleInput').value.trim();
  const author = document.getElementById('pdfAuthorInput').value.trim();
  const lang = document.getElementById('pdfLangSelect').value;
  const voice = document.getElementById('pdfVoiceSelect').value;

  btn.disabled = true;
  btn.textContent = '⏳ Analizando PDF, extrayendo portada y capítulos...';

  try {
    const res = await fetch(apiUrl('/api/upload-pdf'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-Filename': encodeURIComponent(selectedPdfFile.name),
        'X-Title': encodeURIComponent(title),
        'X-Author': encodeURIComponent(author),
        'X-Lang': lang,
        'X-Voice': voice,
      },
      body: selectedPdfFile,
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Error subiendo PDF');
    }

    selectedPdfFile = null;
    document.getElementById('pdfSelectedName').textContent = 'Toca aquí para elegir un archivo PDF';
    document.getElementById('pdfTitleInput').value = '';
    document.getElementById('pdfAuthorInput').value = '';

    showToast(`🎉 Libro "${data.book.book_title_es}" (${data.book.total_chapters} caps) encolado con éxito!`);
    await syncWithServer(false);
    openBookDetail(data.book.id);
    switchTab('library');
  } catch (e) {
    showToast(`❌ Error: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Subir PDF y Generar Audiolibro en Español';
  }
}

async function fetchLocalAudibleBooks() {
  const container = document.getElementById('audibleLocalList');
  if (!isServerOnline) {
    container.innerHTML = `<div style="color: var(--muted); font-size: 0.84rem;">Conéctate a la PC para ver tus archivos de Audible/Libation.</div>`;
    return;
  }
  try {
    const res = await fetch(apiUrl('/api/audible-local'));
    const data = await res.json();
    const list = data.audible_books || [];
    if (list.length === 0) {
      container.innerHTML = `<div style="color: var(--muted); font-size: 0.84rem;">No se encontraron archivos .m4b/.mp3 en <code>C:\\Users\\Ronal\\Libation\\Books</code>.</div>`;
      return;
    }

    container.innerHTML = list
      .map(
        (item) => `
      <div class="chapter-row">
        <div class="ch-left">
          <div class="ch-num">🎧</div>
          <div class="ch-info">
            <div class="ch-title-es">${escapeHtml(item.title)}</div>
            <div class="ch-title-en">
              ${escapeHtml(item.author)} • ${item.total_chapters} capítulos • ${item.duration_hours} h (${item.size_mb} MB)
            </div>
          </div>
        </div>
        <div class="ch-right">
          ${
            item.already_in_library
              ? `<span class="badge offline">✓ En Biblioteca</span>`
              : `<button class="btn btn-primary" style="padding: 8px 13px; font-size: 0.78rem;" onclick="importAudibleBook('${encodeURIComponent(
                  item.path
                )}')">🌐 Traducir al Español</button>`
          }
        </div>
      </div>
    `
      )
      .join('');
  } catch (e) {
    container.innerHTML = `<div style="color: var(--muted);">Error consultando libros locales de Audible.</div>`;
  }
}

async function importAudibleBook(encodedPath) {
  const path = decodeURIComponent(encodedPath);
  const voice = document.getElementById('pdfVoiceSelect')
    ? document.getElementById('pdfVoiceSelect').value
    : 'en-US-BrianMultilingualNeural';

  showToast('⏳ Preparando capítulos y portada del libro de Audible...');
  try {
    const res = await fetch(apiUrl('/api/import-audible'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, voice_id: voice }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Error al importar');

    showToast(`🎉 "${data.book.book_title_es}" agregado a la cola de traducción!`);
    await syncWithServer(false);
    openBookDetail(data.book.id);
    switchTab('library');
  } catch (e) {
    showToast(`❌ Error: ${e.message}`);
  }
}

// --- VISTA 3: COLA Y PROGRESO EN VIVO ---
function renderGeminiPoolBox() {
  const box = document.getElementById('geminiPoolBox');
  if (!box) return;
  if (!isServerOnline || !geminiPoolStatus) {
    box.innerHTML = `<div style="font-size: 0.82rem; color: var(--muted);">Conéctate a la PC para ver el estado del pool Multi-Proyecto Gemini.</div>`;
    return;
  }

  const pCount = geminiPoolStatus.projects_count || 0;
  const rem = geminiPoolStatus.total_rpd_remaining || 0;
  const cap = geminiPoolStatus.total_rpd_capacity || 0;
  const hrs = geminiPoolStatus.est_hours_remaining_today || 0;
  const mins = geminiPoolStatus.est_minutes_remaining_today || 0;
  const projects = geminiPoolStatus.projects || [];

  box.innerHTML = `
    <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 12px; padding: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 8px;">
        <div>
          <strong style="color: #34d399; font-size: 0.92rem;">⚡ ${pCount} Proyecto(s) AI Studio Activo(s)</strong>
          <span style="font-size: 0.8rem; color: var(--muted); margin-left: 8px;">Fecha cuota: ${geminiPoolStatus.pacific_date || ''}</span>
        </div>
        <span class="badge offline">
          🎙️ ${rem}/${cap} peticiones libres hoy (~${hrs} h / ${mins} min de audio gratis)
        </span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${projects
          .map(
            (p) => `
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; background: rgba(15, 23, 42, 0.65); padding: 7px 10px; border-radius: 8px; font-size: 0.78rem;">
            <div>
              <strong>${escapeHtml(p.label)}</strong>
              <code style="color: var(--muted); margin-left: 6px;">${escapeHtml(p.masked_key)}</code>
            </div>
            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              ${(p.models || [])
                .map(
                  (m) =>
                    `<span class="badge ${m.remaining > 0 ? 'pdf' : 'audible'}" title="${escapeHtml(m.label)}">${m.model.replace(
                      'gemini-',
                      ''
                    )}: ${m.remaining}/${m.limit}</span>`
                )
                .join('')}
              <button class="close-sheet-btn" style="padding: 2px 7px; font-size: 0.72rem;" onclick="removeGeminiProjectKey('${p.id}')" title="Quitar clave">✕</button>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;
}

async function addGeminiKeysFromInput() {
  const inp = document.getElementById('geminiNewKeyInput');
  const raw = inp ? inp.value.trim() : '';
  if (!raw) {
    showToast('⚠️ Pega al menos una API Key de un proyecto de Google AI Studio.');
    return;
  }
  try {
    const res = await fetch(apiUrl('/api/gemini/keys'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: raw }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Error agregando clave');
    inp.value = '';
    showToast(`✨ ¡${data.added} nuevo(s) proyecto(s) agregado(s)! Total: ${data.total_projects} proyectos en el pool.`);
    await syncWithServer(false);
  } catch (e) {
    showToast(`❌ ${e.message}`);
  }
}

async function removeGeminiProjectKey(keyId) {
  try {
    const res = await fetch(apiUrl(`/api/gemini/keys/${keyId}`), { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Error eliminando clave');
    showToast('🗑️ Proyecto eliminado del pool.');
    await syncWithServer(false);
  } catch (e) {
    showToast(`⚠️ ${e.message}`);
  }
}

voiceSampleAudio.addEventListener('ended', () => {
  activeSampleVoiceId = null;
  renderCurrentView();
});

async function previewVoiceSample(voiceId, btnEl = null) {
  if (!isServerOnline) {
    showToast('⚠️ Conéctate a tu PC para escuchar muestras de voz.');
    return;
  }
  if (activeSampleVoiceId === voiceId && !voiceSampleAudio.paused) {
    voiceSampleAudio.pause();
    voiceSampleAudio.currentTime = 0;
    activeSampleVoiceId = null;
    if (btnEl) btnEl.textContent = '🔊 Probar Voz';
    renderCurrentView();
    return;
  }

  // Pausar el audiolibro principal si está sonando para oír claramente la muestra
  if (isPlayerLoaded && !audio.paused) {
    audio.pause();
  }

  const origText = btnEl ? btnEl.textContent : '';
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = '⏳ Generando...';
  }
  activeSampleVoiceId = voiceId;
  showToast('🔊 Reproduciendo muestra de voz en español...', 2600);

  try {
    voiceSampleAudio.src = apiUrl(`/api/voice-preview?voice_id=${encodeURIComponent(voiceId)}`);
    await voiceSampleAudio.play();
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = '⏹ Detener';
    }
    renderCurrentView();
  } catch (e) {
    activeSampleVoiceId = null;
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = origText || '🔊 Probar Voz';
    }
    showToast('⚠️ No se pudo reproducir la muestra de voz.');
  }
}

function renderVoiceTesterList() {
  const container = document.getElementById('voiceTesterList');
  if (!container) return;
  const voices = serverVoices && serverVoices.length > 0 ? serverVoices : [];
  if (voices.length === 0) {
    container.innerHTML = `<div style="color: var(--muted); font-size: 0.84rem;">Cargando catálogo de voces de Google...</div>`;
    return;
  }

  const captivateBook = serverBooks.find((b) => b.id.includes('cautivar') || b.id.includes('captivate'));
  const targetBookId = captivateBook ? captivateBook.id : serverBooks[0] ? serverBooks[0].id : null;
  const targetBookTitle = captivateBook ? 'Cautivar (Captivate)' : serverBooks[0] ? serverBooks[0].book_title_es : 'Libro';

  container.innerHTML = voices
    .map((v) => {
      const isPlayingSample = activeSampleVoiceId === v.id && !voiceSampleAudio.paused;
      const isCurrentOnTarget = captivateBook && captivateBook.voice_id === v.id;
      const genderBadge =
        v.gender === 'female'
          ? `<span class="badge audible">👩 Femenina</span>`
          : v.gender === 'male'
          ? `<span class="badge pdf">👨 Masculina</span>`
          : `<span class="badge offline">🔄 Mixta</span>`;

      return `
        <div class="chapter-row" style="cursor: default;">
          <div class="ch-left">
            <div class="ch-num">${v.gender === 'female' ? '👩' : '🎙️'}</div>
            <div class="ch-info">
              <div class="ch-title-es" style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                ${escapeHtml(v.name)}
                ${genderBadge}
                ${isCurrentOnTarget ? `<span class="badge offline">✓ Activa en Cautivar</span>` : ''}
              </div>
              <div class="ch-title-en">${escapeHtml(v.desc || '')}</div>
            </div>
          </div>
          <div class="ch-right" style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button
              type="button"
              class="btn ${isPlayingSample ? 'btn-primary' : 'btn-secondary'}"
              style="padding: 7px 12px; font-size: 0.78rem;"
              onclick="previewVoiceSample('${escapeHtml(v.id)}', this)"
            >
              ${isPlayingSample ? '⏹ Detener' : '▶ Escuchar Muestra'}
            </button>
            ${
              targetBookId
                ? `
              <button
                type="button"
                class="btn ${isCurrentOnTarget ? 'btn-secondary' : 'btn-primary'}"
                style="padding: 7px 12px; font-size: 0.78rem;"
                onclick="assignVoiceToBook('${escapeHtml(targetBookId)}', '${escapeHtml(v.id)}')"
              >
                ${isCurrentOnTarget ? '✓ Seleccionada' : `Usar en ${escapeHtml(targetBookTitle.split(':')[0])}`}
              </button>
            `
                : ''
            }
          </div>
        </div>
      `;
    })
    .join('');
}

async function assignVoiceToBook(bookId, voiceId) {
  const sel = document.getElementById('pdfVoiceSelect');
  if (sel) sel.value = voiceId;
  await switchBookVoice(bookId, voiceId);
}

async function switchBookVoice(bookId, voiceId) {
  try {
    const res = await fetch(apiUrl(`/api/books/${bookId}/voice`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_id: voiceId }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Error cambiando voz');
    showToast(`🎙️ Voz actualizada a: ${data.book.voice}`);
    await syncWithServer(false);
  } catch (e) {
    showToast(`⚠️ ${e.message}`);
  }
}

function renderQueueView() {
  renderGeminiPoolBox();
  const container = document.getElementById('queueBooksList');
  if (!isServerOnline) {
    container.innerHTML = `
      <div style="color: var(--muted); font-size: 0.86rem; padding: 12px 0;">
        📴 Actualmente estás en <strong>Modo Offline</strong>. Conéctate a la PC para ver el progreso de traducción en vivo.
      </div>
    `;
    return;
  }

  if (serverBooks.length === 0) {
    container.innerHTML = `<div style="color: var(--muted);">No hay libros en la cola de la PC.</div>`;
    return;
  }

  container.innerHTML = serverBooks
    .map((b) => {
      const ready = b.ready_chapters || 0;
      const total = b.total_chapters || 1;
      const pct = Math.round((ready / total) * 100);
      const isDone = ready >= total;
      const isPaused = b.status === 'paused';
      const isCharon = (b.voice_id || '').startsWith('gemini-');

      return `
        <div class="section-card" style="margin-bottom: 12px; cursor: pointer;" onclick="openBookDetail('${b.id}'); switchTab('library');">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; flex-wrap: wrap;">
            <div>
              <span class="badge ${b.source_type === 'audible' ? 'audible' : 'pdf'}">${
        b.source_type === 'audible' ? '🎧 Audible' : '📄 PDF'
      }</span>
              <strong style="font-size: 1rem; margin-left: 6px;">${escapeHtml(b.book_title_es)}</strong>
              <div style="font-size: 0.75rem; color: var(--muted); margin-top: 2px;">🎙️ Voz: ${escapeHtml(b.voice || 'Brian')}</div>
            </div>
            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              ${
                !isDone
                  ? `<button class="close-sheet-btn" onclick="event.stopPropagation(); switchBookVoice('${b.id}', '${
                      isCharon ? 'en-US-BrianMultilingualNeural' : 'gemini-charon'
                    }')">
                      ${isCharon ? '🔄 Usar Brian (Ilimitado)' : '✨ Usar Voz Charon (Gemini)'}
                     </button>
                     <button class="close-sheet-btn" onclick="event.stopPropagation(); toggleBookPause('${b.id}', ${!isPaused})">
                      ${isPaused ? '▶ Reanudar' : '⏸ Pausar'}
                     </button>`
                  : ''
              }
              <span class="badge ${isDone ? 'offline' : isPaused ? 'audible' : 'pdf'}">
                ${isDone ? '✅ 100% Completado' : isPaused ? `⏸ Pausado (${ready}/${total})` : `${ready}/${total} caps (${pct}%)`}
              </span>
            </div>
          </div>

          <div class="progress-track" style="margin-bottom: 8px;">
            <div class="progress-fill" style="width: ${pct}%;"></div>
          </div>

          <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--text-secondary);">
            <span>${escapeHtml(b.active_detail || (isDone ? 'Listo para descargar al teléfono' : 'En cola'))}</span>
            <span style="color: var(--muted);">Actualizado: ${b.updated_at || '--:--'}</span>
          </div>

          ${
            !isDone
              ? `
            <div class="progress-track" style="height: 4px; margin-top: 6px;">
              <div class="progress-fill gold" style="width: ${b.active_pct || 0}%;"></div>
            </div>
          `
              : ''
          }
        </div>
      `;
    })
    .join('');
}

async function toggleBookPause(bookId, shouldPause) {
  try {
    const action = shouldPause ? 'pause' : 'resume';
    const res = await fetch(apiUrl(`/api/books/${bookId}/${action}`), { method: 'POST' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Error cambiando estado');
    showToast(shouldPause ? '⏸ Procesamiento pausado (progreso guardado)' : '▶ Procesamiento reanudado');
    await syncWithServer(false);
  } catch (e) {
    showToast(`⚠️ ${e.message}`);
  }
}

// --- MODAL DE ACTIVIDAD E HISTORIAL DIARIO DE ESCUCHA ---
function openActivityModal() {
  const modal = document.getElementById('activityModal');
  const box = document.getElementById('activityModalContent');
  if (!modal || !box) return;
  modal.classList.add('open');

  const act = window.offlineDB.getListeningActivitySync();
  const daily = (act && act.daily_seconds) || {};
  const recent = (act && act.recent_events) || [];
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayMin = Math.round(Number(daily[todayKey] || 0) / 60);

  // Construir últimos 7 días
  const last7Days = [];
  let weekSec = 0;
  let maxDayMin = 1;
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const sec = Number(daily[key] || 0);
    weekSec += sec;
    const mins = Math.round(sec / 60);
    if (mins > maxDayMin) maxDayMin = mins;
    const label = d.toLocaleDateString('es-ES', { weekday: 'short' }).replace('.', '');
    last7Days.push({ key, label, mins, isToday: key === todayKey });
  }
  const weekMin = Math.round(weekSec / 60);

  // Contar capítulos completados totales
  const allBooks = getMergedBooks();
  let totalCompletedChapters = 0;
  let totalBookmarks = 0;
  for (const b of allBooks) {
    const st = getBookListeningStats(b);
    totalCompletedChapters += st.completedCount;
    totalBookmarks += st.bookmarks.length;
  }

  const barsHtml = last7Days
    .map((d) => {
      const hPct = d.mins > 0 ? Math.max(12, Math.round((d.mins / maxDayMin) * 100)) : 4;
      return `
        <div style="flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;">
          <span style="font-size: 0.68rem; color: ${d.mins > 0 ? '#fbbf24' : 'var(--muted)'}; font-weight: 800;">
            ${d.mins > 0 ? `${d.mins}m` : ''}
          </span>
          <div style="width: 100%; max-width: 28px; height: 64px; background: rgba(15,23,42,0.9); border-radius: 8px; display: flex; align-items: flex-end; padding: 2px; border: 1px solid ${
            d.isToday ? 'rgba(245,158,11,0.55)' : 'var(--border)'
          };">
            <div style="width: 100%; height: ${hPct}%; border-radius: 6px; background: ${
        d.mins > 0 ? 'linear-gradient(180deg, #fbbf24, #f59e0b)' : 'rgba(148,163,184,0.15)'
      };"></div>
          </div>
          <span style="font-size: 0.68rem; color: ${d.isToday ? 'var(--text)' : 'var(--muted)'}; font-weight: 700; text-transform: capitalize;">
            ${d.isToday ? 'Hoy' : escapeHtml(d.label)}
          </span>
        </div>
      `;
    })
    .join('');

  const eventsHtml =
    recent.length === 0
      ? `<div style="color: var(--muted); font-size: 0.82rem; padding: 8px 0;">Reproduce cualquier audiolibro para empezar a registrar tu actividad diaria automáticamente (incluso sin internet).</div>`
      : recent
          .slice(0, 12)
          .map((ev) => {
            const mins = Math.max(1, Math.round(Number(ev.seconds_listened || 0) / 60));
            return `
              <div class="bookmark-card" style="cursor: pointer;" onclick="closeActivityModal(); openBookDetail('${escapeHtml(
                ev.book_id
              )}'); switchTab('library');">
                <div style="flex: 1; min-width: 0;">
                  <div style="font-size: 0.8rem; font-weight: 800; color: var(--text);">
                    🎧 ${escapeHtml(ev.book_title || ev.book_id)}
                  </div>
                  <div style="font-size: 0.74rem; color: var(--text-secondary); margin-top: 2px;">
                    Cap. ${ev.chapter_id}: ${escapeHtml(ev.chapter_title || '')}
                  </div>
                </div>
                <div style="text-align: right; flex-shrink: 0;">
                  <span class="badge audible">+${mins} min</span>
                  <div style="font-size: 0.68rem; color: var(--muted); margin-top: 3px;">${escapeHtml(ev.date || '')}</div>
                </div>
              </div>
            `;
          })
          .join('');

  box.innerHTML = `
    <div class="activity-grid">
      <div class="activity-stat-box">
        <div class="activity-stat-val">${formatMinutesCompact(todayMin)}</div>
        <div class="activity-stat-lbl">Escuchado Hoy</div>
      </div>
      <div class="activity-stat-box">
        <div class="activity-stat-val">${formatMinutesCompact(weekMin)}</div>
        <div class="activity-stat-lbl">Últimos 7 días</div>
      </div>
      <div class="activity-stat-box">
        <div class="activity-stat-val">${totalCompletedChapters}</div>
        <div class="activity-stat-lbl">Caps. Completados (${totalBookmarks} 🔖)</div>
      </div>
    </div>

    <div style="background: rgba(8,12,20,0.65); border: 1px solid var(--border); border-radius: 14px; padding: 12px; margin-bottom: 14px;">
      <div style="font-size: 0.76rem; font-weight: 800; color: var(--text-secondary); margin-bottom: 8px;">
        📊 Minutos por día (Última semana)
      </div>
      <div style="display: flex; gap: 6px; align-items: flex-end;">
        ${barsHtml}
      </div>
    </div>

    <div>
      <div style="font-size: 0.78rem; font-weight: 800; color: #fbbf24; margin-bottom: 8px;">
        🕒 Sesiones Recientes por Capítulo
      </div>
      ${eventsHtml}
    </div>
  `;
}

function closeActivityModal() {
  const modal = document.getElementById('activityModal');
  if (modal) modal.classList.remove('open');
}

// --- MODAL DE CONEXIÓN A SERVIDOR PC / GITHUB PAGES / CLOUDFLARE TUNNEL ---
function getEffectivePairingUrl() {
  if (serverPairingUrl) return serverPairingUrl;
  const secret = localStorage.getItem('melo_pair_secret') || '';
  if (secret && serverGhPagesUrl) {
    return `${serverGhPagesUrl.replace(/\/+$/, '')}/#pair=${secret}`;
  }
  return '';
}

async function openServerModal() {
  document.getElementById('serverModal').classList.add('open');
  document.getElementById('serverUrlInput').value = getServerBaseUrl();

  const outboxEl = document.getElementById('pendingOutboxCountText');
  if (outboxEl) {
    outboxEl.textContent = String(window.offlineDB.getPendingOutboxCountSync());
  }

  const ghBox = document.getElementById('ghPagesPairingBox');
  const ghText = document.getElementById('ghPagesUrlText');
  const pairUrl = getEffectivePairingUrl();
  if (ghBox && ghText) {
    if (pairUrl || serverGhPagesUrl) {
      ghBox.style.display = 'block';
      ghText.textContent = pairUrl || serverGhPagesUrl;
    } else {
      ghBox.style.display = 'none';
    }
  }

  const hintEl = document.getElementById('autoPairStatusHint');
  if (hintEl) {
    const hasSecret = Boolean(localStorage.getItem('melo_pair_secret'));
    if (hasSecret) {
      hintEl.textContent = '🔐 Auto-descubrimiento cifrado activo en este dispositivo.';
    } else if (serverPairingUrl) {
      hintEl.textContent = '💡 Abre el Link Permanente naranja en tu celular 1 sola vez para emparejarlo para siempre.';
    } else {
      hintEl.textContent = '';
    }
  }

  const tunnelBox = document.getElementById('detectedTunnelBox');
  if (detectedTunnelUrl) {
    tunnelBox.style.display = 'block';
    document.getElementById('detectedTunnelUrl').textContent = detectedTunnelUrl;
  } else {
    tunnelBox.style.display = 'none';
  }

  const est = await window.offlineDB.getStorageEstimate();
  const dlMB = (downloadedStats.totalBytes / (1024 * 1024)).toFixed(1);
  document.getElementById('storageUsageText').textContent = `${dlMB} MB en audiolibros (Cuota disp: ${
    est.quotaMB > 0 ? est.quotaMB + ' MB' : 'Ilimitada'
  })`;
}

function closeServerModal() {
  document.getElementById('serverModal').classList.remove('open');
}

async function saveServerUrl() {
  const raw = document.getElementById('serverUrlInput').value;
  const normalized = normalizeServerUrl(raw);
  if (normalized) {
    localStorage.setItem('melo_server_url', normalized);
  } else {
    localStorage.removeItem('melo_server_url');
  }
  document.getElementById('serverUrlInput').value = normalized;
  showToast(`🔗 Conectando con ${normalized || 'servidor'}...`);
  await syncWithServer(true);
  if (isServerOnline) {
    showToast('✅ ¡Conectado a tu PC y progreso sincronizado!');
    closeServerModal();
  } else {
    showToast('⚠️ No se pudo conectar. Verifica que tu PC y el túnel estén encendidos.');
  }
}

function copyPairingLink() {
  const link = getEffectivePairingUrl() || serverGhPagesUrl;
  if (!link) return;
  navigator.clipboard.writeText(link).then(() => {
    showToast('📋 Link permanente de GitHub Pages copiado al portapapeles');
  });
}

function copyDetectedTunnel() {
  if (!detectedTunnelUrl) return;
  navigator.clipboard.writeText(detectedTunnelUrl).then(() => {
    showToast('📋 Link directo de Cloudflare copiado al portapapeles');
  });
}

// --- UTILIDADES ---
function formatTime(sec) {
  if (!sec || isNaN(sec) || sec < 0) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Guardar progreso y mantener vivo el MediaSession al minimizar, bloquear pantalla o cerrar pestaña
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    persistCurrentProgress({ immediateServer: true });
    if ('mediaSession' in navigator && isPlayerLoaded) {
      navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
      updateMediaSessionPosition();
    }
  } else {
    syncWithServer(!isServerOnline).finally(() => scheduleNextSyncLoop());
  }
});

window.addEventListener('pagehide', () => {
  persistCurrentProgress({ useBeacon: true });
});

window.addEventListener('beforeunload', () => {
  persistCurrentProgress({ useBeacon: true });
});

window.addEventListener('online', () => {
  showToast('🌐 Conexión detectada • Sincronizando progreso con tu PC...', 2200);
  syncWithServer(true).finally(() => scheduleNextSyncLoop());
});

window.addEventListener('offline', () => {
  isServerOnline = false;
  clearTimeout(syncLoopTimer);
  updateHeaderStatus();
  updateLiveWorkerBanner();
  renderCurrentView();
  showToast('📴 Modo Offline activo • Tu progreso se guarda 100% en el teléfono', 2800);
});

// --- BUCLE ADAPTATIVO DE SINCRONIZACIÓN (CERO BLOQUEOS OFFLINE) ---
function scheduleNextSyncLoop() {
  clearTimeout(syncLoopTimer);
  if (!navigator.onLine) return; // En modo avión / sin datos no gastar batería ni lanzar timeouts
  const delayMs = isServerOnline ? 4500 : 18000;
  syncLoopTimer = setTimeout(() => {
    if (document.visibilityState !== 'hidden') {
      syncWithServer(!isServerOnline).finally(() => scheduleNextSyncLoop());
    } else {
      scheduleNextSyncLoop();
    }
  }, delayMs);
}

// --- ARRANQUE INSTANTÁNEO OFFLINE-FIRST (< 50ms) ---
async function bootApp() {
  capturePairingHashFromUrl();
  const sortEl = document.getElementById('librarySortSelect');
  if (sortEl) sortEl.value = librarySortMode;

  registerMediaSessionHandlers();
  syncSpeedPillsUI();

  // 1. Hidratar biblioteca y progreso local ANTES de cualquier petición de red
  try {
    playbackStates = window.offlineDB.getAllPlaybackStatesSync();
    await refreshLocalStorageState();
    updateHeaderStatus();
    renderCurrentView();
    await restoreLastPlayerSession();
  } catch (err) {
    console.warn('Aviso hidratando estado local inicial:', err);
  }

  // 2. Sincronizar en segundo plano con PC / auto-descubrir túnel en GitHub Pages
  syncWithServer(true).finally(() => scheduleNextSyncLoop());
}

bootApp();
