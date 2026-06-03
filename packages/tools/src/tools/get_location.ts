import { registerTool, fetchJson } from '../registry.js';

// Approx current location from this PC's public IP (no key).
registerTool({
  name: 'get_location',
  description: "Mikkel's approximate current location from the machine's IP (city, region, country, lat/lon).",
  params: {},
  async run() {
    const d = await fetchJson('http://ip-api.com/json/?fields=status,country,regionName,city,lat,lon');
    if (d.status !== 'success') throw new Error('could not determine location');
    return { city: d.city, region: d.regionName, country: d.country, lat: d.lat, lon: d.lon };
  },
});
