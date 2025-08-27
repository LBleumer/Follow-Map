// ===== DSE HOURS (via /api/dse-hours) =====
let DSE_ITEMS = [];
let DSE_BY_MODULE = Object.create(null);
let TABLE_INITIALISED = false;

// Map fm-track 'name' -> DSE moduleName (fill when names differ)
const DSE_NAME_MAP = {
  // "Ranger VKG-13-S": "015K047 Yanmar - 6729699673",
};

// ===== VRM installations (primary presence) =====
let VRM_BY_NAME = Object.create(null);

async function fetchVRMSites() {
  const r = await fetch('/api/vrm-installations', { cache: 'no-store' });
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || 'VRM API error');
  return data.installations || [];
}

function indexVRM(sites) {
  VRM_BY_NAME = Object.create(null);
  for (const s of sites) {
    if (!s || !s.name) continue;
    VRM_BY_NAME[s.name] = s;
  }
}

function hoursToDecimal(hhmmss) {
  if (!hhmmss) return null;
  const [h, m = 0, s = 0] = hhmmss.split(':').map(Number);
  return (h || 0) + (m || 0) / 60 + (s || 0) / 3600;
}

async function fetchDSEHours() {
  const r = await fetch('/api/dse-hours', { cache: 'no-store' });
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || 'DSE API error');
  return data.items || [];
}

function indexDSE(items) {
  DSE_BY_MODULE = Object.create(null);
  for (const it of items) DSE_BY_MODULE[it.moduleName] = it;
}

function renderTable(items) {
  const tbody = document.querySelector('#dse-table tbody');
  const empty = document.getElementById('empty');
  if (!tbody) return; // table not in DOM

  tbody.innerHTML = '';

  if (!items.length) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  // default sort: moduleName
  const sorted = items.slice().sort((a,b) => (a.moduleName||'').localeCompare(b.moduleName||''));

  for (const row of sorted) {
    const tr = document.createElement('tr');
    tr.dataset.module = row.moduleName;
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
  const tbody = document.querySelector('#dse-table tbody');

  const filtered = () => {
    const q = (search?.value || '').toLowerCase();
    return q ? DSE_ITEMS.filter(x => (x.moduleName||'').toLowerCase().includes(q)) : DSE_ITEMS;
  };
  const apply = () => renderTable(filtered());

  search?.addEventListener('input', apply);
  refreshBtn?.addEventListener('click', loadHoursIntoTable);

  // header click sort
  ths.forEach(th => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-k'); // 'moduleName' | 'hours' | 'ts'
      const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
      th.dataset.dir = dir;

      DSE_ITEMS.sort((a,b) => {
        let A = a[key] || '', B = b[key] || '';
        if (key === 'hours') { A = hoursToDecimal(A) ?? -1; B = hoursToDecimal(B) ?? -1; return dir==='asc' ? A-B : B-A; }
        return dir==='asc' ? String(A).localeCompare(String(B)) : String(B).localeCompare(String(A));
      });
      apply();
    });
  });

  // row click -> fly to marker
  tbody?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    flyToVehicleForModule(tr.dataset.module);
  });

  apply(); // initial render with current DSE_ITEMS
  TABLE_INITIALISED = true;
}

async function loadHoursIntoTable() {
  try {
    DSE_ITEMS = await fetchDSEHours();
    indexDSE(DSE_ITEMS);
    if (!TABLE_INITIALISED) attachTableUX(); else renderTable(DSE_ITEMS);
  } catch (err) {
    console.warn('Failed to load DSE hours:', err);
    renderTable([]); // shows "Geen data"
  }
}

// ===== MAP & VEHICLES =====
const map = L.map('map').setView([52.2, 5.3], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap-bijdragers'
}).addTo(map);

const vehicleLayer = L.layerGroup().addTo(map);
const markers = new Map();
let didFit = false;

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
  const key = DSE_NAME_MAP[v.name] || v.name;
  const dse = DSE_BY_MODULE[key];
  const hoursLine = dse ? `Draaiuren: ${dse.hours} <small>(${dse.ts})</small>` : `Draaiuren: -`;
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

    data.vehicles.forEach(v => {
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return;
      seen.add(v.id);

      let m = markers.get(v.id);
      if (!m) {
        m = L.marker([v.lat, v.lon], { icon: vehicleIcon(v.heading) })
             .bindPopup(popupHtml(v))
             .bindTooltip(v.name || 'Onbekend', { direction: "top" })
             .addTo(vehicleLayer);
        markers.set(v.id, m);
      } else {
        m.setLatLng([v.lat, v.lon]);
        m.setIcon(vehicleIcon(v.heading));
        m.setPopupContent(popupHtml(v));
      }
      m.__vehData = v; // keep the vehicle on the marker so the table can find it
      bounds.push([v.lat, v.lon]);
    });

    // remove stale
    for (const [id, m] of markers) {
      if (!seen.has(id)) { vehicleLayer.removeLayer(m); markers.delete(id); }
    }

    if (!didFit && bounds.length) { map.fitBounds(bounds, { padding: [30, 30] }); didFit = true; }
  } catch (err) {
    console.error('Vehicle refresh failed:', err);
  }
}

// link table → map marker
function flyToVehicleForModule(moduleName) {
  const fmName = Object.keys(DSE_NAME_MAP).find(k => DSE_NAME_MAP[k] === moduleName) || moduleName;
  for (const [, m] of markers) {
    const v = m.__vehData;
    if (!v) continue;
    if (v.name === fmName || moduleName.includes(v.name) || fmName.includes(v.name)) {
      map.flyTo(m.getLatLng(), 12, { duration: 0.6 });
      m.openPopup();
      return;
    }
  }
}

const vrmLayer = L.layerGroup().addTo(map);

function drawVRMOnlySites(sites) {
  vrmLayer.clearLayers();
  for (const s of sites) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;

    // Skip if fm-track already has a marker with same/similar name
    let duplicate = false;
    for (const [, m] of markers) {
      const v = m.__vehData;
      if (v && (v.name === s.name || s.name.includes(v.name) || v.name.includes(s.name))) {
        duplicate = true; break;
      }
    }
    if (duplicate) continue;

    L.marker([s.lat, s.lon])
      .bindPopup(`<b>${s.name}</b><br>Last VRM GPS: ${s.last_seen || '-'}`)
      .addTo(vrmLayer);
  }
}


// ===== STARTUP =====
document.addEventListener('DOMContentLoaded', async () => {
  // 1) VRM
  let vrmSites = [];
  try { vrmSites = await fetchVRMSites(); indexVRM(vrmSites); drawVRMOnlySites(vrmSites); }
  catch(e) { console.warn('VRM load failed:', e); }

  // 2) DSE hours (you already have this)
  await loadHoursIntoTable();

  // 3) Vehicles (fm-track)
  refreshVehicles();
  setInterval(refreshVehicles, 10000);
});
