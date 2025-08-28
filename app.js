// ================== Leaflet map ==================
const map = L.map('map').setView([52.2, 5.3], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap-bijdragers'
}).addTo(map);

// Layers
const vehicleLayer = L.layerGroup().addTo(map); // fm-track
const vrmLayer     = L.layerGroup().addTo(map); // VRM GPS markers

// Small bright-green dots (slightly larger for visibility)
function greenDot(lat, lon) {
  return L.circleMarker([lat, lon], {
    radius: 6,
    color: '#00E676',
    weight: 2,
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

// VRM names/sites by unit code (e.g. "006K031" → name)
let VRM_NAME_BY_CODE = Object.create(null);
let VRM_SITES = [];                // [{ idSite, name }]
let VRM_BY_CODE = Object.create(null);

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
  return whole != null ? `${whole} h` : ''; // show blank if unknown
}

// ================== DSE (draaiuren) ==================
async function fetchDSEHours() {
  const r = await fetch('/api/dse-hours', { cache: 'no-store' });
  if (!r.ok) throw new Error(`DSE HTTP ${r.status}`);
  const data = await r.json();
  if (data && data.ok && Array.isArray(data.items)) return data.items;
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

// ================== VRM installations (names list) ==================
async function fetchVRMSites(limit = 9999) {
  const r = await fetch('/api/vrm-installations?limit=' + limit, { cache: 'no-store' });
  if (!r.ok) throw new Error(`VRM list HTTP ${r.status}`);
  const data = await r.json();
  const sites = (data.ok && Array.isArray(data.installations)) ? data.installations : [];
  VRM_SITES = sites;
  VRM_NAME_BY_CODE = Object.create(null);
  VRM_BY_CODE = Object.create(null);
  for (const s of sites) {
    const code = codeFromVRMName(s.name);
    if (code) {
      VRM_NAME_BY_CODE[code] = s.name;
      VRM_BY_CODE[code] = s; // keep idSite too
    }
  }
  return sites;
}

// ================== Combined table (VRM-first names) ==================
function buildCombinedRows() {
  const combined = [];
  const haveCode = new Set();

  // DSE-backed rows (with hours)
  for (const it of DSE_ITEMS) {
    const code = codeFromDSE(it.moduleName);
    if (code) haveCode.add(code);
    const vrmName = (code && VRM_NAME_BY_CODE[code]) ? VRM_NAME_BY_CODE[code] : it.moduleName;
    combined.push({
      displayName: vrmName,
      code: code || null,
      hours: formatHoursShort(it.hours)
    });
  }

  // VRM-only rows (blank hours)
  for (const s of VRM_SITES) {
    const code = codeFromVRMName(s.name);
    if (code && haveCode.has(code)) continue;
    combined.push({
      displayName: s.name,
      code: code || null,
      hours: ''
    });
  }

  combined.sort((a,b) => String(a.displayName||'').localeCompare(String(b.displayName||'')));
  return combined;
}

function renderTableFromCombined() {
  const tbody = document.querySelector('#dse-table tbody');
  const empty = document.getElementById('empty');
  if (!tbody) return;

  const rows = buildCombinedRows();
  tbody.innerHTML = '';

  if (!rows.length) { if (empty) empty.hidden = false; return; }
  if (empty) empty.hidden = true;

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.code = row.code || '';
    tr.dataset.module = row.displayName || '';
    tr.innerHTML = `
      <td>${row.displayName}${row.code ? ` <small class="muted">[${row.code}]</small>` : ''}</td>
      <td class="num">${row.hours}</td>
      <td></td>
    `;
    tbody.appendChild(tr);
  }
}

function attachTableUX() {
  const search = document.getElementById('search');
  const refreshBtn = document.getElementById('refresh');

  function applyFilter() {
    const q = (search?.value || '').toLowerCase();
    document.querySelectorAll('#dse-table tbody tr').forEach(tr => {
      const txt = tr.textContent.toLowerCase();
      tr.style.display = q && !txt.includes(q) ? 'none' : '';
    });
  }
  if (search) search.addEventListener('input', applyFilter);
  if (refreshBtn) refreshBtn.addEventListener('click', reloadAllData);

  const tbody = document.querySelector('#dse-table tbody');
  if (tbody) {
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const code = tr.dataset.code || null;
      const name = tr.dataset.module || '';
      flyToByCodeOrName(code, name);
      highlightTableRow(code, name, true);
    });
  }
}

// ================== Selection helpers (two-way link) ==================
function highlightTableRow(code, name, scroll) {
  const rows = document.querySelectorAll('#dse-table tbody tr');
  let found = null;
  rows.forEach(tr => {
    const match =
      (code && tr.dataset.code && tr.dataset.code === code) ||
      (!code && name && tr.dataset.module === name);
    if (match && !found) found = tr;
    tr.classList.toggle('selected', match);
  });
  if (found && scroll) {
    // scroll a bit into view
    found.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
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
    ? `Draaiuren: ${formatHoursShort(dse.hours)}`
    : `Draaiuren: -`;

  const codeBadge = code ? ` <small class="muted">[${code}]</small>` : '';

  // No "Laatst gezien" and no timestamp next to hours
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

      const code = normalizeCodeLike(v.name);
      let m = markers.get(v.id);
      if (!m) {
        m = greenDot(v.lat, v.lon)
          .bindPopup(popupHtmlForVehicle(v))
          .on('click', () => {
            // two-way: clicking the marker highlights table row
            highlightTableRow(code, v.name, true);
          })
          .addTo(vehicleLayer);
        markers.set(v.id, m);
      } else {
        m.setLatLng([v.lat, v.lon]);
        m.setPopupContent(popupHtmlForVehicle(v));
      }
      m.__vehData = v;
      m.bringToFront?.();

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

    if (bounds.length === 0) {
      console.warn('No vehicles with coordinates from /api/vehicles');
    }
  } catch (err) {
    console.warn('Vehicle refresh failed:', err);
  }
}

function flyToByCodeOrName(code, fallbackName) {
  for (const [, markerObj] of markers) {
    const v = markerObj.__vehData;
    if (!v) continue;
    const vCode = normalizeCodeLike(v.name);
    const match = (code && vCode && code === vCode) || (!code && v.name === fallbackName);
    if (match) {
      map.flyTo(markerObj.getLatLng(), 12, { duration: 0.6 });
      markerObj.openPopup();
      markerObj.bringToFront?.();
      return;
    }
  }
  console.warn('No marker found for', code || fallbackName);
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
    await fetchVRMSites(limit); // fills VRM_SITES + VRM_NAME_BY_CODE + VRM_BY_CODE

    vrmLayer.clearLayers();

    let i = 0, active = 0;
    await new Promise(resolve => {
      const next = async () => {
        if (i >= VRM_SITES.length) { if (active === 0) resolve(); return; }
        const site = VRM_SITES[i++]; active++;
        try {
          if (!hasFMTrackMarkerLike(site.name)) {
            const resp = await fetch(`/api/vrm-gps?idSite=${site.idSite}`, { cache: 'no-store' });
            const j = await resp.json();
            if (j.ok && Number.isFinite(j.lat) && Number.isFinite(j.lon)) {
              const code = codeFromVRMName(site.name);
              const dse = code ? DSE_BY_CODE[code] : null;

              const mk = greenDot(j.lat, j.lon)
                .bindPopup(
                  `<b>${site.name}${code ? ` <small class="muted">[${code}]</small>` : ''}</b><br>` +
                  (dse ? `Draaiuren (DSE): ${formatHoursShort(dse.hours)}` : `Draaiuren (DSE): -`)
                )
                .on('click', () => {
                  // clicking VRM-only marker highlights the table row too
                  highlightTableRow(code, site.name, true);
                })
                .addTo(vrmLayer);

              mk.bringToFront?.();
            }
          }
        } catch (e) {
          console.warn('VRM GPS error for', site.idSite, e);
        } finally {
          active--; next();
        }
      };
      for (let k = 0; k < Math.min(concurrency, VRM_SITES.length); k++) next();
    });

    // Re-render table so VRM names + VRM-only rows appear
    renderTableFromCombined();
  } catch (e) {
    console.warn('VRM markers load failed:', e);
  }
}

// ================== Reload all (order matters) ==================
async function reloadAllData() {
  try {
    DSE_ITEMS = await fetchDSEHours();
  } catch (e) {
    console.warn('DSE fetch failed:', e);
    DSE_ITEMS = [];
  }
  indexDSE(DSE_ITEMS);

  await fetchVRMSites();

  renderTableFromCombined();

  refreshVehicles();
  loadVRMGPSMarkers(150, 6);
}

// ================== Boot ==================
document.addEventListener('DOMContentLoaded', async () => {
  attachTableUX();
  await reloadAllData();

  // Keep fm-track updating
  setInterval(refreshVehicles, 10000);
});
