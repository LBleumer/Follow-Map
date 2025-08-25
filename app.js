// Create the map centered on the Netherlands
const map = L.map('map').setView([52.2, 5.3], 7);

// Add OpenStreetMap tiles as the background
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
