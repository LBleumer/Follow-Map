// ================== Leaflet map ==================
const map = L.map('map').setView([52.2, 5.3], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap-bijdragers'
}).addTo(map);

// Layers
const vehicleLayer = L.layerGroup().addTo(map); // fm-track
const vrmLayer     = L.layerGroup().addTo(map); // VRM GPS markers

// Small bright-green dots
function greenDot(lat, lon) {
  return L.circleMarker([lat, lon], {
    radius: 5,
    color: '#00E676',
    weight: 1,
    fillColor: '#00E676',
    fillOpacity: 0.95
  });
}

// ================== Globals / caches ==================
const markers = new Map(); // fm-track id -> marker
let didFit = false;

let DSE_ITEMS = [];
let DSE_BY_MODULE = Object.create(null);
let DSE_BY_CODE   = Object.create(null);

// VRM names by unit code (e.g. "006K031" → "006K031 (Extra inv. 16) ...")
let VRM_NAME_BY_CODE = Object.create(null);

// Manual overrides if needed (DSE moduleName → unified code)
const MANUAL_MAP = {
  // "259289F0B0B (15K30) - 259289F0B0B": "015K030",
  // "006K031 Yanmar - 6E2A22C092": "006K031",
};

// ================== Code extraction / normalization ==================
function normalizeCodeLike(str) {
  if (!str) return null;
  const s = String(str).toUpperCase();

  // (15K30) → 015K030
  let m = s.match(/\(([0-9A-Z]{2,5})K([0-9A-Z]{2,5})\)/);
  if (m) return `${m[1].padStart(3,'0')}K${m[2].padStart(3,'0')}`;

  // 15K30 or 006K031 in plain text
  m = s.match(/\b(\d{2,3})K(\d{2,3})\b/);
  if (m) return `${m[1].padStart(3,'0')}K${m[2].padStart(3,'0')}`;

  // First token might be the code
  const first = s.split(/[ ,]/)[0].replace(/[^0-9A-Z]/g,'');
  if (/^\d{2,3}K\d{2,3}$/.test(first)) {
    const [a,b] = first.split('K');
    return `${a.padStart(3,'0')}K${b.padStart(3,'0')}`;
  }
  return null;
}
function codeFromDSE(moduleName) {
  if (MANUAL_MAP[moduleName]) return MANUAL_MAP[moduleName];
  return normalizeCodeLike(moduleName);
}
function codeFromVRMName(name) {
  return normalizeCodeLike(name);
}

// ================== Hours helpers ==================
// Convert "HH:MM:SS" or "123,45"/"123.45" → whole hours (floored)
function hoursStringToWholeHours(h) {
  if (!h && h !== 0) return null;
  const s = String(h).trim();
  const m = s.match(/^(\d{1,6}):(\d{1,2}):(\d{1,2})$/);
  if (m) {
    const H = parseInt(m[1], 10) || 0;
    return H; // ignore minutes/seconds
  }
  const dec = parseFloat(s.replace(',', '.'));
  if (!isNaN(dec)) return Math.floor(dec);
  return null;
}
function formatHoursShort(h) {
  const whole = hoursStringToWholeHours(h);
  return whole != null ? `${whole} h` : (h || '');
}

// ================== DSE (draaiuren) ==================
async function fetchDSEHours() {
  const r = await fetch('/api/dse-hours', { cache: 'no-store' });
  if (!r.ok) throw new Error(`DSE HTTP ${r.status}`);
  const data = await r.json();
  // Accept known shapes: { ok:true, items:[...] }
  if (data && data.ok && Array.isArray(data.items)) return data.items;
  // Fallbacks (if backend shape ever changes)
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.vehicles)) return data.vehicles;
  return [];
}

function indexDSE(items) {
  DSE_BY_MODULE = Object.create(null);
  DSE_BY_CODE   = Object.create(null);
  for (const it of items) {
    DSE_BY_MODULE[it.moduleName] = it;
    const c = codeFromDSE(it.moduleName);
    if (c) DSE_BY_CODE[c] = it;
  }
}

function hoursToDecimal(hhmmss) {
  if (!hhmmss) return null;
  const [h, m = 0, s = 0] = String(hhmmss).split(':').map(Number);
  return (h || 0) + (m || 0) / 60 + (s || 0) / 3600;
}

function renderTable(items) {
  const tbody = document.querySelector('#dse-table tbody');
  const empty = document.getElementById('empty');
  if (!tbody) return;

  tbody.innerHTML = '';
  const list = (items || []).slice().sort((a, b) =>
    String(a.moduleName || '').localeCompare(String(b.moduleName || ''))
  );

  if (!list.length) { if (empty) empty.hidden = false; return; }
  if (empty) empty.hidden = true;

  for (const row of list) {
    const code = codeFromDSE(row.moduleName);
    const vrmName = (code && VRM_NAME_BY_CODE[code]) ? VRM_NAME_BY_CODE[code] : row.moduleName || '';
    const tr = document.createElement('tr');
    tr.dataset.module = row.moduleName || '';
    tr.dataset.code   = code || '';
    tr.innerHTML = `
      <td>${vrmName}${code ? ` <small class="muted">[${code}]</small>` : ''}</td>
      <td class="num" title="${row.hours || ''}">${formatHoursShort(row.hours)}</td>
      <td>${row.ts || ''}</td>
    `;
    tbody.appendChild(tr);
  }
}

function attachTableUX() {
  const search = document.getElementById('search');
  const refreshBtn = document.getElementById('refresh');
  const ths = [...document.querySelectorAll('#dse-table thead th')];

  function filtered() {
    const q = (search?.value || '').toLowerCase();
    return q ? DSE_ITEMS.filter(x => (x.moduleName || '').toLowerCase().includes(q)) : DSE_ITEMS;
  }
  function apply() { renderTable(filtered()); }

  if (search) search.addEventListener('input', apply);
  if (refreshBtn) refreshBtn.addEventListener('click', loadHoursIntoTable);

  ths.forEach(th => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-k');
      const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
      th.dataset.dir = dir;

      DSE_ITEMS.sort((a, b) => {
        let A = a[key] ?? '';
        let B = b[key] ?? '';
        if (key === 'hours') {
          A = hoursToDecimal(A) ?? -1;
          B = hoursToDecimal(B) ?? -1;
          return dir === 'asc' ? A - B : B - A;
        }
        return dir === 'asc'
          ? String(A).localeCompare(String(B))
          : String(B).localeCompare(String(A));
      });
      apply();
    });
  });

  const tbody = document.querySelector('#dse-table tbody');
  if (tbody) {
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const moduleName = tr.dataset.module;
      flyToVehicleForModule(moduleName);
    });
  }

  apply();
}

async function loadHoursIntoTable() {
  try {
    DSE_ITEMS = await fetchDSEHours();
  } catch (e) {
    console.warn('DSE fetch failed:', e);
    DSE_ITEMS = [];
  }
  indexDSE(DSE_ITEMS);
  renderTable(DSE_ITEMS);
}

// ================== fm-track vehicles ==================
function popupHtmlForVehicle(v) {
  // Prefer VRM name via shared code; else fall back to fm-track name
  const code = normalizeCodeLike(v.name);
  const displayName = (code && VRM_NAME_BY_CODE[code]) ? VRM_NAME_BY_CODE[code] : v.name;

  // DSE hours via moduleName match OR code match
  const dseByName = DSE_BY_MODULE[v.name];
  const dseByCode = code ? DSE_BY_CODE[code] : null;
  const dse = dseByName || dseByCode;

  const hoursLine = dse
    ? `Draaiuren: ${formatHoursShort(dse.hours)} ${dse.ts ? `<small>(${dse.ts})</small>` : ''}`
    : `Draaiuren: -`;

  const codeBadge = code ? ` <small class="muted">[${code}]</small>` : '';

  // NOTE: no "Laatst gezien" line (per request)
  return `<b>${displayName}${codeBadge}</b><br>
          Snelheid: ${v.speed ?? '-'} km/u<br>
          Richting: ${v.heading ?? '-'}<br>
          ${hoursLine}`;
}

async function refreshVehicles() {
  try {
    const res = await fetch('/api/vehicles', { cache: 'no-store' });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'API error');

    const seen = new Set();
    const bounds = [];

    (data.vehicles || []).forEach(v => {
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return;
      seen.add(v.id);

      let m = markers.get(v.id);
      if (!m) {
        m = greenDot(v.lat, v.lon).bindPopup(popupHtmlForVehicle(v)).addTo(vehicleLayer);
        markers.set(v.id, m);
      } else {
        m.setLatLng([v.lat, v.lon]);
        m.setPopupContent(popupHtmlForVehicle(v));
      }
      m.__vehData = v;
      bounds.push([v.lat, v.lon]);
    });

    // remove stale
    for (const [id, m] of markers) {
      if (!seen.has(id)) {
        vehicleLayer.removeLayer(m);
        markers.delete(id);
      }
    }

    if (!didFit && bounds.length) {
      map.fitBounds(bounds, { padding: [30, 30] });
      didFit = true;
    }
  } catch (err) {
    console.warn('Vehicle refresh failed:', err);
  }
}

// Find fm-track marker for DSE module (click in table → zoom)
function flyToVehicleForModule(moduleName) {
  if (!moduleName) return;
  const code = codeFromDSE(moduleName);

  for (const [, markerObj] of markers) {
    const v = markerObj.__vehData;
    if (!v) continue;

    if (v.name === moduleName) {
      map.flyTo(markerObj.getLatLng(), 12, { duration: 0.6 });
      markerObj.openPopup();
      return;
    }
    const vCode = normalizeCodeLike(v.name);
    if (code && vCode && code === vCode) {
      map.flyTo(markerObj.getLatLng(), 12, { duration: 0.6 });
      markerObj.openPopup();
      return;
    }
  }
}

// ================== VRM GPS (fallback markers) ==================
function hasFMTrackMarkerLike(name) {
  const vrmCode = codeFromVRMName(name);
  for (const [, m] of markers) {
    const v = m.__vehData;
    if (!v) continue;
    const vCode = normalizeCodeLike(v.name);
    if (vrmCode && vCode && vrmCode === vCode) return true;
    if (v.name === name || name.includes(v.name) || v.name.includes(name)) return true;
  }
  return false;
}

async function loadVRMGPSMarkers(limit = 150, concurrency = 6) {
  try {
    const r = await fetch('/api/vrm-installations?limit=' + limit, { cache: 'no-store' });
    if (!r.ok) throw new Error(`VRM list HTTP ${r.status}`);
    const data = await r.json();
    const sites = (data.ok && Array.isArray(data.installations)) ? data.installations : [];
    if (!sites.length) return;

    // Build VRM name map by code (used to rename fm-track markers + table)
    for (const s of sites) {
      const code = codeFromVRMName(s.name);
      if (code) VRM_NAME_BY_CODE[code] = s.name;
    }

    vrmLayer.clearLayers();

    let i = 0, active = 0;
    await new Promise(resolve => {
      const next = async () => {
        if (i >= sites.length) { if (active === 0) resolve(); return; }
        const site = sites[i++]; active++;
        try {
          if (!hasFMTrackMarkerLike(site.name)) {
            const resp = await fetch(`/api/vrm-gps?idSite=${site.idSite}`, { cache: 'no-store' });
            const j = await resp.json();
            if (j.ok && Number.isFinite(j.lat) && Number.isFinite(j.lon)) {
              const code = codeFromVRMName(site.name);
              const dse = code ? DSE_BY_CODE[code] : null;

              greenDot(j.lat, j.lon)
                .bindPopup(
                  `<b>${site.name}${code ? ` <small class="muted">[${code}]</small>` : ''}</b><br>` +
                  (dse ? `Draaiuren (DSE): ${formatHoursShort(dse.hours)}`
                       : `Draaiuren (DSE): -`)
                )
                .addTo(vrmLayer);
            }
          }
        } catch (e) {
          console.warn('VRM GPS error for', site.idSite, e);
        } finally {
          active--; next();
        }
      };
      for (let k = 0; k < Math.min(concurrency, sites.length); k++) next();
    });

    // After VRM map is built, re-render table so VRM names appear there too
    renderTable(DSE_ITEMS);
  } catch (e) {
    console.warn('VRM markers load failed:', e);
  }
}

// ================== Boot ==================
document.addEventListener('DOMContentLoaded', async () => {
  attachTableUX();
  await loadHoursIntoTable();          // DSE table + indices (inc. code)

  refreshVehicles();                   // fm-track markers (green dots)
  setInterval(refreshVehicles, 10000);

  loadVRMGPSMarkers(150, 6);           // VRM markers + VRM names map (also updates table names)
});
