// Bestaande map:
const map = L.map('map').setView([52.2, 5.3], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

const layer = L.layerGroup().addTo(map);
const markers = new Map();

async function refreshVehicles() {
  try {
    const res = await fetch('/api/vehicles');
    if (!res.ok) throw new Error(await res.text());
    const { vehicles } = await res.json();

    const seen = new Set();
    vehicles.forEach(v => {
      if (typeof v.lat !== 'number' || typeof v.lon !== 'number') return;
      seen.add(v.id);
      let m = markers.get(v.id);
      const html = `<b>${v.id}</b><br>${new Date(v.ts).toLocaleString()}<br>` +
                   `Speed: ${v.speed ?? '-'} | Heading: ${v.heading ?? '-'}`;
      if (!m) {
        m = L.marker([v.lat, v.lon]).bindPopup(html);
        m.addTo(layer);
        markers.set(v.id, m);
      } else {
        m.setLatLng([v.lat, v.lon]).setPopupContent(html);
      }
    });

    // Remove verdwenen voertuigen
    for (const [id, m] of markers) {
      if (!seen.has(id)) { layer.removeLayer(m); markers.delete(id); }
    }
  } catch (e) {
    console.error('Vehicle refresh failed', e);
  }
}

refreshVehicles();
setInterval(refreshVehicles, 5000); // pas aan op rate limits
