# Grace — kickoff til selv-udviklings-mission (dansk)

Alt du skal bruge for at sætte Grace i gang med at udvikle sine egne tools i et loop —
uden at mumle dig igennem det eller glemme detaljer. Læs **Manuskript B** højt til hende.

---

## 1) Før du starter (én gang)

```powershell
# Stå på en grace/*-branch, så hun kan committe sit eget arbejde uden at røre andre branches:
git checkout -b grace/self-dev      # oprettes fra feat/autonomous-self-dev

# Byg:
npm run build                        # skal være exit 0

# Pre-flight røgtest (tjekker Docker + Ollama + hele byg-kæden, rydder selv op):
node scripts/mission-smoke.mjs       # skal sige "ALL GREEN"

# Anbefalet: lad hende kunne afbrydes med stemmen MENS hun taler (sikkert med dine øretelefoner):
$env:GRACE_VOICE_BARGEIN = "1"

# Start hende:
./start-grace.ps1
```

> Hun committer KUN på en `grace/*`-branch, KUN tool-filer (`packages/tools`), og hun
> skifter/merger/pusher aldrig. Andre branches er derfor urørlige.

---

## 2) Sådan starter du missionen (uden at mumle)

1. Sig: **"slå lyttelapperne ud"** (eller "lytte efter") → hun går i lytte-mode og er stille.
2. Læs **Manuskript B** højt — tag pauser, tænk, ret dig selv. Hun afbryder dig ikke.
3. Slut af med: **"så kør"** / **"gå i gang"** → nu samler hun det hele og går i gang.

Hvis hun er i tvivl om noget midt i, kan hun spørge — men målet er at hun bare kører.

---

## 3) Manuskript A — lille RØGTEST-mission (kør denne FØRST)

> Brug den til at se hele flowet (plan → byg → progress-fil → commit) på få minutter,
> før du giver hende den store opgave.

> "Grace, jeg vil gerne have dig til at starte en mission. Målet er en lille test:
> byg tre simple, rene udregnings-tools til dig selv — for eksempel et der tæller ord i
> en tekst, et der konverterer mellem temperatur-enheder, og et der regner antal dage
> mellem to datoer. Lav en kort plan, byg dem ét ad gangen, test hver enkelt, og skriv
> løbende din fremgang ned. Gå i gang."

---

## 4) Manuskript B — den fulde 3-fase mission

> "Grace, jeg vil gerne sætte dig i gang med en lang mission, hvor du arbejder selvstændigt
> i flere timer uden at vente på mig. Det handler om at udvikle dine egne tools. Der er tre faser.
>
> **Fase ét — forstå dig selv.** Tænk grundigt over dit eget formål: hvad du er sat i verden
> for, hvilke tools du allerede har, og hvad du selv tror du mangler eller har brug for for at
> blive bedre. Skriv det hele ned i en fil i mappen Dokumenter, i en undermappe der hedder
> Grace-mission — kald filen fase1-selvvurdering.
>
> **Fase to — undersøg verden.** Søg på internettet: Hvordan virker store agentiske workflows?
> Hvilke tools har de? Hvordan får de så gode resultater og outputs? Hvilke tools mener andre
> folk er relevante for en agent som dig? Saml det du finder, og skriv det ned i en ny fil i
> samme mappe — kald den fase2-research.
>
> **Fase tre — konsolidér og byg.** Læg de to filer sammen. Vurder og prioritér: hvad er mest
> essentielt, og hvad skal laves først? Vigtigt: start med de tools jeg IKKE skal involveres i —
> altså rene udregnings- og læse-tools der ikke kræver login, OAuth, API-nøgler eller andre ting
> jeg skal angive. Du må gerne også skrive koden til de tools der senere kræver min godkendelse,
> men husk at jeg ikke er her til at give input undervejs, så dem lægger du bare til side til mig.
> Skriv din prioriterede plan ned i en fil — fase3-plan — og gå så i gang med at udvikle og
> teste de tools, ét ad gangen.
>
> Skriv løbende din fremgang ned: hvilke tools du har lavet, hvad de gør, og hvordan testen gik —
> så jeg kan stoppe dig uden varsel uden at din fremgang går tabt. Bliv ved gennem hele listen,
> og vent ikke på mig. Jeg afbryder dig selv hvis jeg har brug for det. Gå i gang."

---

## 5) Sådan styrer du hende undervejs

**Med stemmen** (virker mellem hendes trin; med `GRACE_VOICE_BARGEIN=1` også mens hun taler):
- "stop" — stop alt med det samme
- "pause" / "fortsæt" — sæt på pause / genoptag
- "status" / "hvor langt er du" — hun fortæller hvor hun er

**Med tastatur** (virker ALTID, også mens hun taler — mikrofonen er "døv" der):
- **Ctrl+Shift+S** — stop alt
- **Ctrl+Shift+Mellemrum** — pause / fortsæt
- **Ctrl+Shift+.** — talt status
- **Ctrl+Shift+H** — slå lytte-mode til/fra

---

## 6) Hvor finder du fremgangen

- **Hendes egne filer:** `Dokumenter\Grace-mission\` (fase1-selvvurdering, fase2-research, fase3-plan).
- **Den automatiske progress-fil (driveren skriver den selv efter hvert tool):**
  `grace\data\missions\<mission-id>.md` — backlog, hvad der er bygget / venter på dit ja / fejlede,
  og hvad der er tilbage. Den opdateres løbende, så intet går tabt hvis du stopper hende.
- **Git:** hendes færdige tools committes på `grace/self-dev` — kør `git log --oneline` for at se dem.
