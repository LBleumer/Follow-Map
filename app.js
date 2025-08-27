// ===== DSE HOURS (via /api/dse-hours) =====
let DSE_ITEMS = [];
let DSE_BY_MODULE = Object.create(null);

// Handige mapping als de namen tussen fm-track en DSE niet 1:1 zijn.
// Vul aan waar nodig: "fm-track name" : "DSE moduleName"
const DSE_NAME_MAP = {
  // "Ranger VKG-13-S": "015K047 Yanmar - 6729699673",
};

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
  for (const it of items) {
    DSE_BY_MODULE[it.moduleName] = it;
  }
}

function renderTable(items) {
  const tbody = document.querySelector('#dse-table tbody');
  const empty = document.getElementById('empty');
  tbody.innerHTML = '';

  if (!items.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  // default sort: moduleName
  items = items.slice().sort((a,b) => (a.moduleName||'').localeCompare(b.moduleName||''));

  const now = Date.now();
  for (const row of items) {
    const tr = document.createElement('tr');
    tr.dataset.module = row.moduleName;

    // kleur op "freshness": ouder dan 7 dagen licht grijs
    let cls = '';
    if (row.ts) {
      // ts is bv. "27-08-2025 12:55:37 CEST" — we tonen gewoon string
      // (wil je strikte parsing, zeg het even)
      const stale = /(\d{2})-(\d{2})-(\d{4})/.test(row.ts) ? false : false; // placeholder
      if (stale) cls = 'stale';
    }

    tr.className = cls;
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
    const q = (search.value || '').toLowerCase();
    return q ? DSE_ITEMS.filter(x => (x.moduleName||'').toLowerCase().includes(q)) : DSE_ITEMS;
  }

  function applyFilterAndRender() { renderTable(filtered()); }

  search.addEventListener('input', applyFilterAndRender);
  if (refreshBtn) refreshBtn.addEventListener('click', loadHoursIntoTable);

  // klik-kop om te sorteren op kolom
  ths.forEach(th => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-k');       // 'moduleName' | 'hours' | 'ts'
      const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
      th.dataset.dir = dir;

      DSE_ITEMS.sort((a,b) => {
        let A = a[key] || '';
        let B = b[key] || '';
        // voor 'hours' beter numeriek sorteren op decimale uren
        if (key === 'hours') {
          A = hoursToDecimal(A) ?? -1;
          B = hoursToDecimal(B) ?? -1;
          return dir === 'asc' ? A - B : B - A;
        }
        return dir === 'asc'
          ? String(A).localeCompare(String(B))
          : String(B).localeCompare(String(A));
      });
      applyFilterAndRender();
    });
  });

  // klik op rij → flyTo marker (als we ‘m vinden)
  const tbody = document.querySelector('#dse-table tbody');
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const moduleName = tr.dataset.module;
    flyToVehicleForModule(moduleName);
  });

  applyFilterAndRender();
}

async function loadHoursIntoTable() {
  try {
    DSE_ITEMS = await fetchDSEHours();
    indexDSE(DSE_ITEMS);
    renderTable(DSE_ITEMS);
  } catch (err) {
    console.warn('Failed to load DSE hours:', err);
    renderTable([]);
  }
}

// Zoeken naar bijbehorende marker op de kaart
function flyToVehicleForModule(moduleName) {
  // probeer mapping → fm-track naam
  const fmName = Object.keys(DSE_NAME_MAP).find(k => DSE_NAME_MAP[k] === moduleName) || moduleName;

  // markers is een Map() die we hieronder vullen in refreshVehicles
  for (const [id, markerObj] of markers) {
    const v = markerObj.__vehData;
    if (!v) continue;
    // match op naam of bevat
    if (v.name === fmName || moduleName.includes(v.name) || fmName.includes(v.name)) {
      map.flyTo(markerObj.getLatLng(), 12, { duration: 0.6 });
      markerObj.openPopup();
      return;
    }
  }
  // geen match gevonden → niks doen (of toast)
}

// kick off the table on page load
document.addEventListener('DOMContentLoaded', () => {
  loadHoursIntoTable();
  const btn = document.getElementById('refresh');
  if (btn) btn.addEventListener('click', loadHoursIntoTable);
});

// Basemap
const map = L.map('map').setView([52.2, 5.3], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap-bijdragers'
}).addTo(map);

// Markerlaag + cache
const vehicleLayer = L.layerGroup().addTo(map);
const markers = new Map();
let didFit = false;

// Eenvoudig autootje-icoontje
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
  return `<b>${v.name || 'Onbekend'}</b><br>
          Laatst gezien: ${when}<br>
          Snelheid: ${v.speed ?? '-'} km/u<br>
          Richting: ${v.heading ?? '-'}`;
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
             .addTo(vehicleLayer);
        markers.set(v.id, m);
      } else {
        m.setLatLng([v.lat, v.lon]);
        m.setIcon(vehicleIcon(v.heading));
        m.setPopupContent(popupHtml(v));
      }
      bounds.push([v.lat, v.lon]);
    });

    // verwijder voertuigen die niet meer in de feed staan
    for (const [id, m] of markers) {
      if (!seen.has(id)) {
        vehicleLayer.removeLayer(m);
        markers.delete(id);
      }
    }

    // één keer automatisch inzoomen op alle voertuigen
    if (!didFit && bounds.length) {
      map.fitBounds(bounds, { padding: [30, 30] });
      didFit = true;
    }
  } catch (err) {
    console.error('Vehicle refresh failed:', err);
  }
}

// start + interval
refreshVehicles();
setInterval(refreshVehicles, 5000);
