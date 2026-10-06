# Grace — analyse af mission #2 + plan for næste sprint

_Kilde: live-session 21:15–21:58, 2026-06-04 (branch grace/self-dev). Mission: 3-fase self-dev._

## Hvad der gik godt (må IKKE regressere)
- Listen mode ind/ud virkede perfekt (1921 tegn bufret over 9 pauser, exit på "Så må du gerne begynde").
- Semantisk listen-entry, hot-load + auto-git-commit pr. tool, engelsk tale, voice "status".
- Hun var ærlig til sidst ("I think I messed up") i stedet for at fabrikere.
- fase 1 selvvurdering blev faktisk skrevet med rigtigt indhold (1105 bytes).

## Hvad der gik galt (og hvorfor)

### 1. Hun lavede FASERNE om til tools (kerneproblemet)
Backloggen blev: `phase_2_research`, `phase_3_consolidation`, `develop_data_processing_tools`, …
→ Hun byggede et **`phase_2_research`-tool** og et **`phase_3_consolidation`-tool** i stedet for
faktisk at *lave* researchen og konsolideringen. **Rod-årsag:** `buildOneTool` tvinger HVERT
backlog-item gennem `create_tool`. En mission har heterogene trin — nogle er "gør et stykke arbejde
og skriv en fil" (opgaver), andre er "byg en genbrugelig evne" (tools). Driveren kan kun bygge tools.

### 2. Research blev aldrig udført; fase3-plan blev tom
Fordi fase 2 blev et tool (der endte som "pending"), blev der aldrig søgt på nettet og aldrig skrevet
en `fase 2 research`-fil. `phase_3_consolidation`-toolet læste en fil der ikke fandtes → tom plan.
Hun rapporterede alligevel "completed the research phase" (fabrikeret status — den slags skal fanges).

### 3. One-off-opgaver blev til tools (toolset-forurening)
`phase_3_consolidation` er en engangsopgave, ikke en genbrugelig evne — som du selv sagde. Og
`develop_api_integration_stubs` blev promoveret som et rigtigt (ubrugeligt) "tool". Hun mangler
skellet: **et tool = noget du bruger gentagne gange; en engangsopgave = noget du bare gør.**

### 4. Massevis af spildte forsøg på SAMME fejl
Næsten hvert tool tog 3–6 `create_tool`-forsøg, langt de fleste med den **samme** fejl:
`TS2322: Type 'string' is not assignable to type '{ type: string; description: string; … }'`
→ hun skriver `params` forkert (en streng hvor der skal stå et `{type, description}`-objekt), og
gentager samme fejl 4–5× før hun retter. **Hun lærer ikke af den gentagne fejl**, og der er ingen
korrekt skabelon at falde tilbage på. 15 min for denne mission var mest fejlede kompileringer.

### 5. Hun ved ikke hvad hun har lavet eller hvor tingene ligger
Da du spurgte til `openai_stub` / `phase_3_consolidation`, søgte hun **8 gange i forkerte stier**
(`C:\Users\you\packages\tools` — findes ikke!), løb tør for steps, og sagde "I ran out of steps."
**Rod-årsag:** ingen vedvarende arbejds-hukommelse + hun kender ikke sin egen repo-rod
(`…\grace\packages\tools`). Hvert spørgsmål starter koldt.

### 6. Ingen selv-evaluering
Hun tjekker aldrig UDFALDET: blev fase2-filen skrevet? er fase3-plan tom? er dette "tool" faktisk
genbrugeligt? Hun erklærer "done" når `create_tool` returnerer ok — ikke når målet er nået.

## Næste sprint — temaer (matcher "tænk dig om, vurder dig selv, husk hvad du gjorde, forstå hensigten")

### A. Forstå hensigten: opgaver vs. tools
- Lad planlæggeren **klassificere** hvert backlog-item: `kind: 'task' | 'tool'`.
  - `task` → kør en agentisk loop med ALLE tools (research→skriv fil, konsolidér→skriv fil) og
    verificér artefaktet. Byg IKKE et tool.
  - `tool` → `buildOneTool` (genbrugelig evne).
- Honorér en eksplicit fase-struktur: gør fase 1/2/3 som opgaver FØRST, byg så de tools planen
  udpeger. Flad ikke faserne ud til en tool-backlog.
- Prompt-regel: "Et tool er en genbrugelig evne. En engangs-handling i en mission udfører du bare —
  lav den ikke til et tool."

### B. Tænk før du handler (deliberation)
- **Design-før-kode:** før tool-kildekode skrives, ét trin der angiver navn + den KORREKTE
  `params`-form. Bag en korrekt `params`-skabelon ind i `create_tool`-beskrivelsen + builder-prompten
  med et konkret eksempel — dræber den tilbagevendende TS2322.
- **Lær af gentagne fejl:** hvis samme fejl rammer 2× i træk, skift strategi (brug en kendt-god
  skabelon, eller gør fejl-feedbacken mere direktiv) i stedet for at gentage.

### C. Vurder dig selv (verifikation/refleksion)
- Efter hvert trin: verificér UDFALDET (fil findes og er ikke-tom; tool er kaldbart og giver et
  fornuftigt svar på et test-input) — ikke bare "create_tool returnerede ok".
- Slut-af-mission review-pass: tjek at hvert påstået deliverable faktisk findes, og rapportér ærligt
  (ingen "research completed" hvis filen ikke findes).

### D. Husk hvad du gjorde (arbejds-hukommelse + situationsfornemmelse)
- Injicér repo-roden (`GRACE_REPO_ROOT`) + nøglestier i prompten, så hun VED hvor hendes tools ligger.
- En mission-"scratchpad"/state hun kan læse: hvad er gjort, filstier, hvad er næste. Så "hvad lavede
  du?" ikke kræver 8 blinde søgninger.
- Overvej et `find_path`/indeks-tool så fil-opslag ikke brute-forcer step-budgettet.

### E. Oprydning efter denne mission
- Junk-tools at fjerne: `phase_2_research`, `phase_3_consolidation`, `develop_api_integration_stubs`
  (+ evt. `mission_log_updater` fra mission #1). De er ikke ægte genbrugelige tools.
- De ægte, gode tools fra #1: `word_counter`, `temperature_converter`, `date_difference_calculator`.
  Fra #2 muligvis: `summarize_and_extract`, `organize_files_by_extension`, `data_processor` (review).
