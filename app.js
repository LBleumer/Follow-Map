// -------- TABLE: load from API (/api/dse-hours) and render --------
async function fetchDSEHours() {
  // Preferred: our server-side function that reads the SAS CSV URL
  const r = await fetch('/api/dse-hours', { cache: 'no-store' });
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || 'DSE API error');
  // returns: { ok, count, items: [{ gateway, moduleName, hours, ts }] }
  return data.items || [];
}

function renderTable(items) {
  const tbody = document.querySelector('#dse-table tbody');
  const empty = document.querySelector('#empty');
  tbody.innerHTML = '';

  if (!items.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  // default: sort by name
  items.sort((a, b) => (a.moduleName || '').localeCompare(b.moduleName || ''));

  for (const row of items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.moduleName || ''}</td>
      <td class="num">${row.hours || ''}</td>
      <td>${row.ts || ''}</td>
    `;
    tbody.appendChild(tr);
  }
}

function attachTableUX(allItems) {
  const search = document.getElementById('search');
  const ths = [...document.querySelectorAll('#dse-table thead th')];

  function applyFilterAndRender() {
    const q = (search.value || '').toLowerCase();
    const filtered = q
      ? allItems.filter(x => (x.moduleName || '').toLowerCase().includes(q))
      : allItems.slice();
    renderTable(filtered);
  }

  search.addEventListener('input', applyFilterAndRender);

  // click-to-sort
  ths.forEach(th => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-k');
      const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
      th.dataset.dir = dir;
      allItems.sort((a, b) => {
        const A = (a[key] || '').toString();
        const B = (b[key] || '').toString();
        return dir === 'asc' ? A.localeCompare(B) : B.localeCompare(A);
      });
      applyFilterAndRender();
    });
  });

  applyFilterAndRender();
}

async function loadHoursIntoTable() {
  try {
    const items = await fetchDSEHours();
    attachTableUX(items);
  } catch (err) {
    console.warn('Failed to load DSE hours:', err);
    renderTable([]); // shows "Geen data"
  }
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
