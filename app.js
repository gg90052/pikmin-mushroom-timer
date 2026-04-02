'use strict';

// ── IndexedDB ──────────────────────────────────────────────────────────────
const DB_NAME = 'PikminTimerDB';
const DB_VERSION = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('images')) d.createObjectStore('images');
    };
  });
}

function dbPut(store, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const GRACE_MS = 5 * 60 * 1000; // 5-minute grace period after expiry

// ── State ──────────────────────────────────────────────────────────────────
let markers = [];         // { id, title, x, y, expiresAt, totalMs }
let pendingX = 0;
let pendingY = 0;
let pendingDeleteId = null;
let tickInterval = null;
let imageObjectURL = null;
const scheduledNotifications = new Map(); // markerId → [timeoutId, ...]

// ── DOM Refs ───────────────────────────────────────────────────────────────
const emptyState = document.getElementById('empty-state');
const mapView = document.getElementById('map-view');
const mapImage = document.getElementById('map-image');
const markersLayer = document.getElementById('markers-layer');
const fileInput = document.getElementById('file-input');
const markerCountEl = document.getElementById('marker-count');
const modalOverlay = document.getElementById('modal-overlay');
const markerTitleInput = document.getElementById('marker-title');
const timeHours = document.getElementById('time-hours');
const timeMinutes = document.getElementById('time-minutes');
const timeSeconds = document.getElementById('time-seconds');
const deleteOverlay = document.getElementById('delete-overlay');
const deleteMarkerName = document.getElementById('delete-marker-name');

// ── Persistence ────────────────────────────────────────────────────────────
function loadMarkers() {
  try {
    const data = localStorage.getItem('pikmin_markers');
    markers = data ? JSON.parse(data) : [];
  } catch { markers = []; }
}

function saveMarkers() {
  localStorage.setItem('pikmin_markers', JSON.stringify(markers));
}

// ── Notifications ─────────────────────────────────────────────────────────
async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

async function pushNotification(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification(title, { body, icon: './icon.svg', tag, vibrate: [200, 100, 200] });
  } catch {
    new Notification(title, { body, icon: './icon.svg', tag });
  }
}

function scheduleMarkerNotifications(marker) {
  cancelMarkerNotifications(marker.id);
  const now = Date.now();
  const ids = [];

  const WARN = 30_000; // 30 seconds before

  // 30s before original countdown ends
  const t1 = marker.expiresAt - WARN - now;
  if (t1 > 0) {
    ids.push(setTimeout(() =>
      pushNotification(`🍄 ${marker.title}`, '倒數結束前 30 秒！即將進入 5 分鐘緩衝', `expiry-${marker.id}`)
    , t1));
  }

  // 30s before grace period ends
  const t2 = (marker.expiresAt + GRACE_MS) - WARN - now;
  if (t2 > 0) {
    ids.push(setTimeout(() =>
      pushNotification(`⏰ ${marker.title}`, '緩衝時間剩 30 秒，香菇即將消失！', `grace-${marker.id}`)
    , t2));
  }

  if (ids.length) scheduledNotifications.set(marker.id, ids);
}

function cancelMarkerNotifications(id) {
  const ids = scheduledNotifications.get(id);
  if (ids) { ids.forEach(clearTimeout); scheduledNotifications.delete(id); }
}

// ── Utilities ──────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function formatTime(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Returns { phase, fraction, color, text } for a marker at current time
function getMarkerInfo(marker) {
  const now = Date.now();
  const remaining = marker.expiresAt - now;

  if (remaining > 0) {
    // Active: red pie depleting from full → empty
    const fraction = Math.min(1, remaining / (marker.totalMs || remaining));
    return { phase: 'active', fraction, color: '#e03030', text: formatTime(remaining) };
  }

  const graceRemaining = (marker.expiresAt + GRACE_MS) - now;
  if (graceRemaining > 0) {
    // Grace period: green pie depleting
    const fraction = Math.min(1, graceRemaining / GRACE_MS);
    return { phase: 'grace', fraction, color: '#3cc83c', text: formatTime(graceRemaining) };
  }

  return { phase: 'expired', fraction: 0, color: '#888', text: '已結束' };
}

// ── Marker Rendering ───────────────────────────────────────────────────────
function renderAllMarkers() {
  markersLayer.innerHTML = '';
  markers.forEach(renderMarker);
  updateMarkerCount();
}

function renderMarker(marker) {
  const info = getMarkerInfo(marker);

  const el = document.createElement('div');
  el.className = `marker state-${info.phase}`;
  el.dataset.id = marker.id;
  el.style.left = (marker.x * 100) + '%';
  el.style.top = (marker.y * 100) + '%';

  const bubble = document.createElement('div');
  bubble.className = 'marker-bubble';

  const titleEl = document.createElement('div');
  titleEl.className = 'marker-title';
  titleEl.textContent = marker.title;

  const countdown = document.createElement('div');
  countdown.className = 'marker-countdown';
  countdown.textContent = info.text;

  bubble.appendChild(titleEl);
  bubble.appendChild(countdown);
  el.appendChild(bubble);

  const pie = document.createElement('div');
  pie.className = 'marker-pie';
  pie.style.setProperty('--pie-color', info.color);
  pie.style.setProperty('--pie-pct', (info.fraction * 100).toFixed(1) + '%');
  el.appendChild(pie);

  addLongPressHandler(el, marker.id);
  markersLayer.appendChild(el);
}

// ── Long Press to Delete ───────────────────────────────────────────────────
let longPressTimer = null;

function addLongPressHandler(el, markerId) {
  const DURATION = 500;

  function start(e) {
    e.stopPropagation();
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      confirmDelete(markerId);
    }, DURATION);
  }
  function cancel() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }

  // Prevent single-click from bubbling to markersLayer (which would open the add modal)
  el.addEventListener('click', (e) => e.stopPropagation());

  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend',   cancel);
  el.addEventListener('touchmove',  cancel);

  // Desktop: hold mouse button or right-click
  el.addEventListener('mousedown',  (e) => { if (e.button === 0) start(e); });
  el.addEventListener('mouseup',    cancel);
  el.addEventListener('mouseleave', cancel);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); confirmDelete(markerId); });
}

function updateMarkerEl(id) {
  const marker = markers.find(m => m.id === id);
  if (!marker) return;
  const el = markersLayer.querySelector(`[data-id="${id}"]`);
  if (!el) return;

  const info = getMarkerInfo(marker);
  el.className = `marker state-${info.phase}`;

  const cd = el.querySelector('.marker-countdown');
  if (cd) cd.textContent = info.text;

  const pie = el.querySelector('.marker-pie');
  if (pie) {
    pie.style.setProperty('--pie-color', info.color);
    pie.style.setProperty('--pie-pct', (info.fraction * 100).toFixed(1) + '%');
  }
}

function updateMarkerCount() {
  const now = Date.now();
  const active  = markers.filter(m => m.expiresAt > now).length;
  const grace   = markers.filter(m => m.expiresAt <= now && (m.expiresAt + GRACE_MS) > now).length;
  const expired = markers.filter(m => (m.expiresAt + GRACE_MS) <= now).length;
  const parts = [];
  if (active)  parts.push(`${active} 個倒數`);
  if (grace)   parts.push(`${grace} 緩衝中`);
  if (expired) parts.push(`${expired} 已結束`);
  markerCountEl.textContent = parts.length ? parts.join(' · ') : '0 個標記';
}

// ── Tick ──────────────────────────────────────────────────────────────────
function startTick() {
  if (tickInterval) return;
  tickInterval = setInterval(() => {
    markers.forEach(m => updateMarkerEl(m.id));
    updateMarkerCount();
  }, 1000);
}

// ── Single-click to add marker ─────────────────────────────────────────────
markersLayer.addEventListener('click', (e) => {
  if (e.target.closest('.marker')) return;
  const rect = markersLayer.getBoundingClientRect();
  const xPct = (e.clientX - rect.left) / rect.width;
  const yPct = (e.clientY - rect.top) / rect.height;
  openAddModal(xPct, yPct);
});


// ── Add Marker Modal ───────────────────────────────────────────────────────
function openAddModal(xPct, yPct) {
  pendingX = xPct;
  pendingY = yPct;
  markerTitleInput.value = '';
  timeHours.value = '0';
  timeMinutes.value = '30';
  timeSeconds.value = '0';
  modalOverlay.classList.remove('hidden');
  setTimeout(() => markerTitleInput.focus(), 100);
}

function closeAddModal() {
  modalOverlay.classList.add('hidden');
}

document.getElementById('modal-cancel').addEventListener('click', closeAddModal);
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeAddModal();
});

document.getElementById('modal-save').addEventListener('click', async () => {
  // Must request from a user-gesture (required by iOS Safari)
  await requestNotificationPermission();
  const title = markerTitleInput.value.trim() || '香菇';
  const h = parseInt(timeHours.value) || 0;
  const m = parseInt(timeMinutes.value) || 0;
  const s = parseInt(timeSeconds.value) || 0;
  const totalMs = (h * 3600 + m * 60 + s) * 1000;

  if (totalMs <= 0) {
    timeMinutes.focus();
    return;
  }

  const marker = {
    id: uid(),
    title,
    x: pendingX,
    y: pendingY,
    totalMs,
    expiresAt: Date.now() + totalMs
  };

  markers.push(marker);
  saveMarkers();
  scheduleMarkerNotifications(marker);
  renderMarker(marker);
  updateMarkerCount();
  closeAddModal();
});

// Numeric input convenience: select all on focus
[timeHours, timeMinutes, timeSeconds].forEach(input => {
  input.addEventListener('focus', () => input.select());
});

// Quick time buttons
document.querySelectorAll('.quick-time-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const add = parseInt(btn.dataset.seconds);
    let total = (parseInt(timeHours.value) || 0) * 3600
              + (parseInt(timeMinutes.value) || 0) * 60
              + (parseInt(timeSeconds.value) || 0)
              + add;
    timeHours.value   = Math.floor(total / 3600);
    timeMinutes.value = Math.floor((total % 3600) / 60);
    timeSeconds.value = total % 60;
  });
});

// ── Delete Marker ──────────────────────────────────────────────────────────
function confirmDelete(id) {
  const marker = markers.find(m => m.id === id);
  if (!marker) return;
  pendingDeleteId = id;
  deleteMarkerName.textContent = `「${marker.title}」`;
  deleteOverlay.classList.remove('hidden');
}

document.getElementById('delete-cancel').addEventListener('click', () => {
  deleteOverlay.classList.add('hidden');
  pendingDeleteId = null;
});

document.getElementById('delete-confirm').addEventListener('click', () => {
  if (!pendingDeleteId) return;
  cancelMarkerNotifications(pendingDeleteId);
  markers = markers.filter(m => m.id !== pendingDeleteId);
  saveMarkers();
  const el = markersLayer.querySelector(`[data-id="${pendingDeleteId}"]`);
  if (el) el.remove();
  pendingDeleteId = null;
  deleteOverlay.classList.add('hidden');
  updateMarkerCount();
});

// ── Clear Expired ──────────────────────────────────────────────────────────
document.getElementById('clear-expired-btn').addEventListener('click', () => {
  markers
    .filter(m => (m.expiresAt + GRACE_MS) <= Date.now())
    .forEach(m => cancelMarkerNotifications(m.id));
  markers = markers.filter(m => (m.expiresAt + GRACE_MS) > Date.now());
  saveMarkers();
  renderAllMarkers();
});

// ── Image Handling ─────────────────────────────────────────────────────────
function showMap() {
  emptyState.classList.add('hidden');
  mapView.classList.remove('hidden');
  startTick();
}

async function loadStoredImage() {
  try {
    const blob = await dbGet('images', 'mapImage');
    if (blob) {
      setMapImage(blob);
      return true;
    }
  } catch (e) { console.warn('No stored image', e); }
  return false;
}

function setMapImage(blob) {
  if (imageObjectURL) URL.revokeObjectURL(imageObjectURL);
  imageObjectURL = URL.createObjectURL(blob);
  mapImage.src = imageObjectURL;
  showMap();
}

async function handleFileSelected(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    await dbPut('images', 'mapImage', file);
  } catch (e) { console.warn('Could not save image to IndexedDB', e); }
  setMapImage(file);
}

// File input
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFileSelected(fileInput.files[0]);
  fileInput.value = '';
});

document.getElementById('upload-btn').addEventListener('click', () => fileInput.click());
document.getElementById('change-image-btn').addEventListener('click', () => fileInput.click());

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  loadMarkers();
  await openDB();
  const hasImage = await loadStoredImage();
  if (hasImage) {
    renderAllMarkers();
  }
  // Re-schedule any pending notifications on page load (if already permitted)
  if ('Notification' in window && Notification.permission === 'granted') {
    markers.forEach(scheduleMarkerNotifications);
  }
}

init();
