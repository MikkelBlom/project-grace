# Grace — Næste session: Overlay features + Power/Mode system

## ✅ Allerede fikset
- Tekstlæsbarhed: grace-bubble har nu rgba(18,14,42,0.93) baggrund + text-shadow

---

## 🔧 Overlay features

### 1. Multi-monitor support
**Hvad:** Grace skal dukke op på den aktive/primære skærm, og det skal kunne konfigureres.
**Hvordan:**
- I `main.ts`: brug `screen.getAllDisplays()` til at liste alle skærme
- Tilføj `config.overlay.displayIndex` (0 = primær, 1 = anden, -1 = auto/aktiv skærm)
- Repositioner vinduet til den valgte skærms `workArea`
- Lyt på `system:contextUpdate` — hvis aktiv app er på anden skærm, flyt overlay med
- Genvej Ctrl+Shift+M til at flytte overlay til næste skærm manuelt

### 2. Vignette — ramme rundt om skærmen når Grace er aktiv
**Hvad:** Et subtilt glødende kant-overlay på hele skærmen der viser Graces tilstand.
**Farveskema — lilla/purple som primær identitetsfarve:**
- Lytter: lilla gløde `rgba(99, 85, 212, 0.20)` — rolig pulserende
- Tænker: amber `rgba(245, 158, 11, 0.18)` — langsom rotation/sweep
- Taler: grøn `rgba(26, 158, 108, 0.18)` — blød wave-animation
- Diskret Mode: rød `rgba(220, 38, 38, 0.15)` — statisk, ingen animation
- Slumre/Batteri: ingen vignette (Grace er passiv)
**Hvordan:**
- Separat Electron BrowserWindow: fuld skærmstørrelse, transparent, ingen frame, klik-igennem, alwaysOnTop
- CSS `box-shadow: inset 0 0 100px 30px <farve>` — midten er 100% gennemsigtig
- Smooth CSS transition 0.5s ease på farve og opacity
- Fil: `packages/overlay/src/vignetteWindow.ts` + `renderer/vignette.html`

### 3. Focus boxes — annotér skærmelementer Grace refererer til
**Hvad:** Animeret kasse der fremhæver et element på skærmen Grace refererer til.
**Polished/premium animation spec:**
- Kassen drawer sig selv fra hjørnet med en SVG stroke-dashoffset animation (0.4s, cubic-bezier easing)
- Lilla/purple border `#7c6af7` med corner-dots i hjørnerne
- Subtil indholds-glow: `box-shadow: inset 0 0 30px rgba(99,85,212,0.12)`
- Label tooltip glider ind fra toppen med fade + translateY(-6px → 0)
- Forsvinder med reverse-animation (kassen trækkes tilbage) efter duration
- Kan have pulserende state hvis Grace ak