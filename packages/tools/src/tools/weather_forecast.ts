import { registerTool } from '../registry.js';

const WMO: Record<number, string> = {
  0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 85: 'snow showers', 86: 'snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};

// Multi-day forecast (get_weather is current-only). Defaults to IP location; accepts a city.
registerTool({
  name: 'weather_forecast',
  description: "Multi-day weather forecast (get_weather is current-only). Use when Mikkel asks about the coming days' weather. Defaults to his current location; pass a city for elsewhere.",
  params: {
    city: { type: 'string', description: 'city name (optional; defaults to current location)' },
    days: { type: 'number', description: 'forecast days (default 5, max 7)' },
  },
  async run(args) {
    const days = Math.max(1, Math.min(7, Number(args.days) || 5));
    let lat: number, lon: number, place: string;
    try {
      if (String(args.city ?? '').trim()) {
        const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(String(args.city).trim())}&count=1`, { signal: AbortSignal.timeout(8000) });
        if (!g.ok) return { error: `geocoding service returned HTTP ${g.status}` };
        const gd = (await g.json()) as any;
        const r = gd?.results?.[0];
        if (!r) return { error: `city not found: ${args.city}` };
        lat = r.latitude; lon = r.longitude; place = `${r.name}, ${r.country_code}`;
      } else {
        const l = await fetch('http://ip-api.com/json/', { signal: AbortSignal.timeout(8000) });
        if (!l.ok) return { error: `location service returned HTTP ${l.status}` };
        const ld = (await l.json()) as any;
        if (typeof ld?.lat !== 'number' || typeof ld?.lon !== 'number') return { error: 'could not determine your location' };
        lat = ld.lat; lon = ld.lon; place = `${ld.city}, ${ld.countryCode}`;
      }
      const f = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=${days}&timezone=auto`, { signal: AbortSignal.timeout(8000) });
      if (!f.ok) return { error: `forecast service returned HTTP ${f.status}` };
      const fd = (await f.json()) as any;
      const d = fd?.daily;
      if (!d?.time || !Array.isArray(d.temperature_2m_max) || !Array.isArray(d.weather_code)) return { error: 'forecast unavailable' };
      const forecast = d.time.map((date: string, i: number) => ({
        date,
        highC: d.temperature_2m_max[i],
        lowC: d.temperature_2m_min?.[i],
        conditions: WMO[d.weather_code[i]] ?? `code ${d.weather_code[i]}`,
      }));
      return { place, days: forecast.length, forecast };
    } catch (e) { return { error: String(e) }; }
  },
});
