import { registerTool, fetchJson } from '../registry.js';

// Current local weather (Open-Meteo, no key). Uses IP location if lat/lon omitted.
registerTool({
  name: 'get_weather',
  description: 'Current weather. If lat/lon are omitted, the current IP location is used automatically.',
  params: {
    lat: { type: 'number', description: 'latitude (optional)' },
    lon: { type: 'number', description: 'longitude (optional)' },
  },
  async run(args) {
    let lat = args.lat, lon = args.lon, place = '';
    if (lat == null || lon == null) {
      const loc = await fetchJson('http://ip-api.com/json/?fields=status,city,lat,lon');
      lat = loc.lat; lon = loc.lon; place = loc.city ?? '';
    }
    const w = await fetchJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code',
    );
    const c = w.current ?? {};
    return {
      place,
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
      weather_code: c.weather_code,
    };
  },
});
