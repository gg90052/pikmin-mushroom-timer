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

// ── State ──────────────────────────────────────────────────────────────────
let markers = [];         // { id, title, x, y, expiresAt }
let pendingX = 0;
let pendingY = 0;
let selectedMarkerId = null;
let pendingDeleteId = null;
let tickInterval = null;
let imageObjectURL = null;

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

// ── Utilities ──────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function formatCountdown(ms) {
  if (ms <= 0) return '已過期';
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function getMarkerState(ms) {
  if (ms <= 0) return 'expired';
  if (ms < 60_000) return 'red urgent';
  if (ms < 300_000) return 'red';
  if (ms < 900_000) return 'orange';
  if (ms < 3_600_000) return 'yellow';
  return 'green';
}

function getTimeLabel(ms) {
  return formatCountdown(ms);
}

// ── Marker Rendering ───────────────────────────────────────────────────────
function renderAllMarkers() {
  markersLayer.innerHTML = '';
  markers.forEach(renderMarker);
  updateMarkerCount();
}

function renderMarker(marker) {
  const remaining = marker.expiresAt - Date.now();
  const stateClasses = getMarkerState(remaining);

  const el = document.createElement('div');
  el.className = `marker state-${stateClasses}`;
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
  countdown.textContent = getTimeLabel(remaining);

  bubble.appendChild(titleEl);
  bubble.appendChild(countdown);
  el.appendChild(bubble);

  const pin = document.createElement('div');
  pin.className = 'marker-pin';
  el.appendChild(pin);

  // Tap to select / deselect
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSelectMarker(marker.id);
  });

  markersLayer.appendChild(el);
}

function toggleSelectMarker(id) {
  if (selectedMarkerId === id) {
    deselectMarker();
  } else {
    selectMarker(id);
  }
}

function selectMarker(id) {
  deselectMarker();
  selectedMarkerId = id;

  const el = markersLayer.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  el.classList.add('selected');

  // Add delete button
  const btn = document.createElement('div');
  btn.className = 'marker-delete-btn';
  btn.textContent = '×';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmDelete(id);
  });
  el.querySelector('.marker-bubble').appendChild(btn);
}

function deselectMarker() {
  if (!selectedMarkerId) return;
  const el = markersLayer.querySelector(`[data-id="${selectedMarkerId}"]`);
  if (el) {
    el.classList.remove('selected');
    const btn = el.querySelector('.marker-delete-btn');
    if (btn) btn.remove();
  }
  selectedMarkerId = null;
}

function updateMarkerEl(id) {
  const marker = markers.find(m => m.id === id);
  if (!marker) return;
  const el = markersLayer.querySelector(`[data-id="${id}"]`);
  if (!el) return;

  const remaining = marker.expiresAt - Date.now();
  const stateClasses = getMarkerState(remaining);

  // Update class
  el.className = `marker state-${stateClasses}${selectedMarkerId === id ? ' selected' : ''}`;

  // Update countdown text
  const cd = el.querySelector('.marker-countdown');
  if (cd) cd.textContent = getTimeLabel(remaining);
}

function updateMarkerCount() {
  const active = markers.filter(m => m.expiresAt > Date.now()).length;
  const expired = markers.length - active;
  if (expired > 0) {
    markerCountEl.textContent = `${active} 個有效 · ${expired} 已過期`;
  } else {
    markerCountEl.textContent = `${markers.length} 個標記`;
  }
}

// ── Tick ──────────────────────────────────────────────────────────────────
function startTick() {
  if (tickInterval) return;
  tickInterval = setInterval(() => {
    markers.forEach(m => updateMarkerEl(m.id));
    updateMarkerCount();
  }, 1000);
}

// ── Double-tap detection ───────────────────────────────────────────────────
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;

markersLayer.addEventListener('touchend', (e) => {
  if (e.target.classList.contains('marker-delete-btn')) return;

  const now = Date.now();
  const touch = e.changedTouches[0];
  const x = touch.clientX;
  const y = touch.clientY;

  const isDouble =
    now - lastTapTime < 350 &&
    Math.abs(x - lastTapX) < 40 &&
    Math.abs(y - lastTapY) < 40;

  if (isDouble) {
    e.preventDefault();
    lastTapTime = 0;
    // Only add if not tapping an existing marker
    if (!e.target.closest('.marker')) {
      const rect = markersLayer.getBoundingClientRect();
      const xPct = (x - rect.left) / rect.width;
      const yPct = (y - rect.top) / rect.height;
      openAddModal(xPct, yPct);
    }
  } else {
    lastTapTime = now;
    lastTapX = x;
    lastTapY = y;
    // Tap on empty area deselects
    if (!e.target.closest('.marker')) {
      deselectMarker();
    }
  }
}, { passive: false });

// Desktop double-click support
markersLayer.addEventListener('dblclick', (e) => {
  if (e.target.closest('.marker')) return;
  const rect = markersLayer.getBoundingClientRect();
  const xPct = (e.clientX - rect.left) / rect.width;
  const yPct = (e.clientY - rect.top) / rect.height;
  openAddModal(xPct, yPct);
});

// Click on empty area deselects (desktop)
markersLayer.addEventListener('click', (e) => {
  if (!e.target.closest('.marker')) {
    deselectMarker();
  }
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

document.getElementById('modal-save').addEventListener('click', () => {
  const title = markerTitleInput.value.trim() || '蘑菇';
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
    expiresAt: Date.now() + totalMs
  };

  markers.push(marker);
  saveMarkers();
  renderMarker(marker);
  updateMarkerCount();
  closeAddModal();
});

// Numeric input convenience: select all on focus
[timeHours, timeMinutes, timeSeconds].forEach(input => {
  input.addEventListener('focus', () => input.select());
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
  markers = markers.filter(m => m.id !== pendingDeleteId);
  saveMarkers();
  const el = markersLayer.querySelector(`[data-id="${pendingDeleteId}"]`);
  if (el) el.remove();
  selectedMarkerId = null;
  pendingDeleteId = null;
  deleteOverlay.classList.add('hidden');
  updateMarkerCount();
});

// ── Clear Expired ──────────────────────────────────────────────────────────
document.getElementById('clear-expired-btn').addEventListener('click', () => {
  markers = markers.filter(m => m.expiresAt > Date.now());
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
}

init();
