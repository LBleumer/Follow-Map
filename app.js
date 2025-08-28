// ================== Leaflet map ==================
const map = L.map('map').setView([52.2, 5.3], 7);

// Dedicated panes so cars are above VRM dots
map.createPane('vrmPane');        // VRM dots (lower)
map.getPane('vrmPane').style.zIndex = 640;
map.createPane('vehiclesPane');   // Vehicles (higher)
map.getPane('vehiclesPane').style.zIndex = 650;

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap-bijdragers'
}).addTo(map);

// Layers
const vehicleLayer = L.layerGroup().addTo(map); // fm-track cars
const vrmLayer     = L.layerGroup().addTo(map); // VRM GPS markers

// ================== Marker helpers ==================
function vehicleIcon(angleDeg) {
  const rot = Number.isFinite(angleDeg) ? angleDeg : 0;
  return L.divIcon({
    className: 'veh',
    html: `<div class="veh-emoji" style="transform: rotate(${rot}deg);">🚗</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
}

function greenDotVRM(lat, lon) {
  return L.circleMarker([lat, lon], {
    pane: 'vrmPane',
    radius: 6,
    color: '#00E676',
    weight: 2,
    fillColor: '#00E676',
    fillOpacity: 0.95
  });
}

// ================== Globals / caches ==================
const markers = new Map();               // fm-track id -> Leaflet marker
const CODE_TO_MARKER = new Map();        // "006K031" -> fm-track marker
const VRM_CODE_TO_MARKER = new Map();    // "006K031" -> VRM dot

let didFit = false;

let DSE_ITEMS = [];
let DSE_BY_MODULE = Object.create(null);
let DSE_BY_CODE   = Object.create(null);

let VRM_SITES = [];                      // [{ idSite, name }]
let VRM_NAME_BY_CODE = Object.create(null);
let VRM_BY_CODE = Object.create(null);

// Manual overrides if needed (DSE moduleName → unified code)
// const MANUAL_MAP = { "example DSE module name": "015K030" };

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

  // first token might be the code
  const first = s.split(/[ ,]/)[0].replace(/[^0-9A-Z]/g,'');
  if (/^\d{2,3}K\d{2,3}$/.test(first)) {
    const [a,b] = first.split('K');
    return `${a.padStart(3,'0')}K${b.padStart(3,'0')}`;
  }
  return null;
}

function codeFromDSE(moduleName) {
  // if (MANUAL_MAP[moduleName]) return MANUAL_MAP[moduleName];
  return normalizeCodeLike(moduleName);
}
function codeFromVRMName(name) {
  return normalizeCodeLike(name);
}

// Try to infer a unit code for a vehicle (helps when fm-track name lacks a code)
function inferCodeForVehicleName(vName) {
  let code = normalizeCodeLike(vName);
  if (code) return code;

  // try match against DSE module names
  for (const [c, item] of Object.entries(DSE_BY_CODE)) {
    const mname = item.moduleName || '';
    if (!mname) continue;
    if (mname.includes(vName) || vName.includes(mname)) return c;
  }

  // try match against VRM site names
  for (const [c, name] of Object.entries(VRM_NAME_BY_CODE)) {
    if (!name) continue;
    if (name.includes(vName) || vName.includes(name)) return c;
  }
  return null;
}

// ================== Hours helpers ==================
// "HH:MM:SS" or "123,45"/"123.45" → whole hours (floored)
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
  return whole != null ? `${whole} h` : '';
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
      VRM_BY_CODE[code] = s;
    }
  }
  return sites;
}

// ================== Combined table (VRM-first names) ==================
function buildCombinedRows() {
  const combined = [];
  const haveCode = new Set();

  // DSE rows (with hours)
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
    const rowCode = row.code || codeFromVRMName(row.displayName) || null;
    const tr = document.createElement('tr');
    tr.dataset.code = rowCode || '';
    tr.dataset.module = row.displayName || '';
    tr.innerHTML = `
      <td>${row.displayName}${rowCode ? ` <small class="muted">[${rowCode}]</small>` : ''}</td>
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
      let code = tr.dataset.code || '';
      const name = tr.dataset.module || '';
      if (!code) code = codeFromVRMName(name) || '';
      flyToByCodeOrName(code || null, name);
      highlightTableRow(code || null, name, true);
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
  if (found && scroll) found.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ================== fm-track vehicles (cars) ==================
function popupHtmlForVehicle(v) {
  const code = normalizeCodeLike(v.name);
  const displayName = (code && VRM_NAME_BY_CODE[code]) ? VRM_NAME_BY_CODE[code] : v.name;

  const dseByName = DSE_BY_MODULE[v.name];
  const dseByCode = code ? DSE_BY_CODE[code] : null;
  const dse = dseByName || dseByCode;

  const hoursLine = dse ? `Draaiuren: ${formatHoursShort(dse.hours)}` : `Draaiuren: -`;
  const codeBadge = code ? ` <small class="muted">[${code}]</small>` : '';

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
      const lat = Number(v.lat);
      const lon = Number(v.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      const id = v.id || v.name;

      let m = markers.get(id);
      if (!m) {
        m = L.marker([lat, lon], {
              pane: 'vehiclesPane',
              icon: vehicleIcon(v.heading)
            })
            .bindPopup(popupHtmlForVehicle(v))
            .on('click', () => {
              const code = m.__code || inferCodeForVehicleName(v.name);
              const displayName = (code && VRM_NAME_BY_CODE[code]) ? VRM_NAME_BY_CODE[code] : v.name;
              highlightTableRow(code || null, displayName, true);
            })
            .addTo(vehicleLayer);
        markers.set(id, m);
      } else {
        m.setLatLng([lat, lon]);
        m.setIcon(vehicleIcon(v.heading));
        m.setPopupContent(popupHtmlForVehicle(v));
      }

      // infer & store a stable code on the marker, and index it
      const inferred = inferCodeForVehicleName(v.name);
      m.__code = inferred || null;
      if (inferred) CODE_TO_MARKER.set(inferred, m);

      m.__vehData = v;
      m.bringToFront?.();
      bounds.push([lat, lon]);
      seen.add(id);
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

// ================== VRM GPS (generator systems) ==================
function hasFMTrackMarkerLike(name) {
  const vrmCode = codeFromVRMName(name);
  for (const [, m] of markers) {
    const v = m.__vehData;
    if (!v) continue;
    const vCode = m.__code || normalizeCodeLike(v.name);
    if (vrmCode && vCode && vrmCode === vCode) return true;
    if (v.name === name || name.includes(v.name) || v.name.includes(name)) return true;
  }
  return false;
}

async function loadVRMGPSMarkers(limit = 150, concurrency = 6) {
  try {
    await fetchVRMSites(limit);   // fills VRM_SITES, VRM_NAME_BY_CODE, VRM_BY_CODE
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
              const dse  = code ? DSE_BY_CODE[code] : null;

              const popup = `<b>${site.name}${code ? ` <small class="muted">[${code}]</small>` : ''}</b><br>` +
                            (dse ? `Draaiuren (DSE): ${formatHoursShort(dse.hours)}` : `Draaiuren: -`);

              const mk = greenDotVRM(j.lat, j.lon)
                .bindPopup(popup)
                .on('click', () => {
                  highlightTableRow(code || null, site.name, true);
                })
                .addTo(vrmLayer);

              mk.__code = code || null;
              mk.__name = site.name || '';
              if (code) VRM_CODE_TO_MARKER.set(code, mk);
              // stays visually below vehicles because of pane zIndex
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

    renderTableFromCombined(); // ensure VRM-only rows appear
  } catch (e) {
    console.warn('VRM markers load failed:', e);
  }
}

// ================== Jump logic (table → map, cars first, then VRM) ==================
function flyToByCodeOrName(code, fallbackName) {
  const targetCode = code || (fallbackName ? normalizeCodeLike(fallbackName) : null);

  // 1) Cars by code
  if (targetCode && CODE_TO_MARKER.has(targetCode)) {
    const mk = CODE_TO_MARKER.get(targetCode);
    map.flyTo(mk.getLatLng(), 12, { duration: 0.6 });
    mk.openPopup(); mk.bringToFront?.();
    return;
  }

  // 2) VRM by code
  if (targetCode && VRM_CODE_TO_MARKER.has(targetCode)) {
    const mk = VRM_CODE_TO_MARKER.get(targetCode);
    map.flyTo(mk.getLatLng(), 12, { duration: 0.6 });
    mk.openPopup(); mk.bringToFront?.();
    return;
  }

  // 3) Scan cars by name/code
  for (const [, markerObj] of markers) {
    const v = markerObj.__vehData;
    if (!v) continue;
    const vCode = markerObj.__code || normalizeCodeLike(v.name);
    const nameMatch = fallbackName &&
      (v.name === fallbackName || fallbackName.includes(v.name) || v.name.includes(fallbackName));
    if ((targetCode && vCode && targetCode === vCode) || nameMatch) {
      map.flyTo(markerObj.getLatLng(), 12, { duration: 0.6 });
      markerObj.openPopup(); markerObj.bringToFront?.();
      return;
    }
  }

  // 4) Scan VRM markers by name/code
  let found = null;
  vrmLayer.eachLayer(l => {
    if (found) return;
    const vCode = l.__code || null;
    const vName = l.__name || '';
    const nameMatch = fallbackName &&
      (vName === fallbackName || fallbackName.includes(vName) || vName.includes(fallbackName));
    if ((targetCode && vCode && targetCode === vCode) || nameMatch) found = l;
  });
  if (found) {
    map.flyTo(found.getLatLng(), 12, { duration: 0.6 });
    found.openPopup(); found.bringToFront?.();
    return;
  }

  console.warn('No marker found for', code || fallbackName);
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
