// === Simple, robust app.js ===

// ---------- Leaflet map ----------
const map = L.map('map').setView([52.2, 5.3], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap-bijdragers'
}).addTo(map);

// Layers
const vehicleLayer = L.layerGroup().addTo(map); // fm-track
const vrmLayer     = L.layerGroup().addTo(map); // VRM GPS markers

// Cache for fm-track markers
const markers = new Map(); // id -> Leaflet marker
let didFit = false;

// ---------- DSE (hours) ----------
let DSE_ITEMS = [];
let DSE_BY_MODULE = Object.create(null);

// Optional mapping if names differ between fm-track and DSE
const DSE_NAME_MAP = {
  // "FM name" : "DSE moduleName"
  // "Ranger VKG-13-S": "015K047 Yanmar - 6729699673",
};

function hoursToDecimal(hhmmss) {
  if (!hhmmss) return null;
  const [h, m = 0, s = 0] = String(hhmmss).split(':').map(Number);
  return (h || 0) + (m || 0) / 60 + (s || 0) / 3600;
}

async function fetchDSEHours() {
  const r = await fetch('/api/dse-hours', { cache: 'no-store' });
  if (!r.ok) throw new Error(`DSE HTTP ${r.status}`);
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || 'DSE API error');
  return Array.isArray(data.items) ? data.items : [];
}

function indexDSE(items) {
  DSE_BY_MODULE = Object.create(null);
  for (const it of items) DSE_BY_MODULE[it.moduleName] = it;
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
    const tr = document.createElement('tr');
    tr.dataset.module = row.moduleName || '';
    tr.innerHTML = `
      <td>${row.moduleName || ''}</td>
      <td class="num" title="${row.hours || ''}">${row.hours || ''}</td>
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
      flyToVehicleForModule(tr.dataset.module);
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

// ---------- fm-track vehicles ----------
function vehicleIcon(angleDeg) {
  const rot = Number.isFinite(angleDeg) ? angleDeg : 0;
  return L.divIcon({
    className: 'veh',
    html: `<div style="transform: rotate(${rot}deg);">🚗</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
}

function popupHtml(v) {
  const when = v.ts ? new Date(v.ts).toLocaleString() : '-';

  // Map fm name -> DSE key (if provided), else try same string
  const dseKey = DSE_NAME_MAP[v.name] || v.name;
  const dse = DSE_BY_MODULE[dseKey];

  const hoursLine = dse
    ? `Draaiuren: ${dse.hours} <small>${dse.ts ? `(${dse.ts})` : ''}</small>`
    : `Draaiuren: -`;

  return `<b>${v.name || v.id}</b><br>
          Laatst gezien: ${when}<br>
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
        m = L.marker([v.lat, v.lon], { icon: vehicleIcon(v.heading) })
             .bindPopup(popupHtml(v))
             .addTo(vehicleLayer);
        markers.set(v.id, m);
      } else {
        m.setLatLng([v.lat, v.lon]);
        m.setIcon(vehicleIcon(v.heading));
        m.setPopupContent(popupHtml(v));
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

// Fly to vehicle whose fm name matches a DSE moduleName (or mapping)
function flyToVehicleForModule(moduleName) {
  if (!moduleName) return;
  const fmName = Object.keys(DSE_NAME_MAP).find(k => DSE_NAME_MAP[k] === moduleName) || moduleName;

  for (const [, markerObj] of markers) {
    const v = markerObj.__vehData;
    if (!v) continue;
    if (v.name === fmName || moduleName.includes(v.name) || fmName.includes(v.name)) {
      map.flyTo(markerObj.getLatLng(), 12, { duration: 0.6 });
      markerObj.openPopup();
      return;
    }
  }
}

// ---------- VRM GPS (fallback markers) ----------
function hasFMTrackMarkerLike(name) {
  for (const [, m] of markers) {
    const v = m.__vehData;
    if (v && (v.name === name || name.includes(v.name) || v.name.includes(name))) return true;
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

    vrmLayer.clearLayers();

    // Simple promise pool for gentle concurrency
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
              L.marker([j.lat, j.lon])
                .bindPopup(
                  `<b>${site.name}</b><br>` +
                  `VRM GPS (${j.source || 'widget'})<br>` +
                  (j.ts ? new Date(j.ts).toLocaleString() + '<br>' : '') +
                  (j.speed != null ? `Snelheid: ${(j.speed*3.6).toFixed(1)} km/u<br>` : '') +
                  (j.alt != null ? `Hoogte: ${j.alt} m` : '')
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
  } catch (e) {
    console.warn('VRM markers load failed:', e);
  }
}

// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', async () => {
  attachTableUX();
  await loadHoursIntoTable();          // Fill DSE hours + table

  refreshVehicles();                   // fm-track vehicles now
  setInterval(refreshVehicles, 10000);

  loadVRMGPSMarkers(150, 6);           // Add VRM markers for sites missing fm-track
});
