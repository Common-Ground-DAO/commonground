# Roadmap: Captcha-Härtung (Fail-closed + ALTCHA)

> Fix für Review-Finding (mittel, 2026-07-23): Ohne `GOOGLE_RECAPTCHA_SECRET_KEY` gibt
> `verifyRecaptchaToken()` in `srv/api/user.ts` pauschal `true` zurück — Selfhost-Instanzen
> haben damit keinerlei Bot-/Spam-Schutz bei der Registrierung (Frontend schickt `token:'stub'`).

## Zielbild

Captcha-Schutz, der **ohne externe Dienste und ohne Konfiguration** überall aktiv ist
(fail-closed), mit reCAPTCHA als optionalem Provider für die gehostete Instanz.

**Gewählte Lösung: [ALTCHA](https://altcha.org)** — state of the art, open source (MIT),
selbst-hostbar, Proof-of-Work-basiert (kein Tracking, kein Cookie, DSGVO-freundlich,
keine Third-Party-Calls). Braucht serverseitig nur einen HMAC-Secret → kann auf jeder
Instanz automatisch aktiv sein.

## Architektur

- **Provider-Abstraktion** `CAPTCHA_PROVIDER = altcha | recaptcha | off`
  - Default: `altcha` (fail-closed; aktiv ohne jede Konfiguration)
  - `recaptcha`: bisheriges Verhalten, wenn `GOOGLE_RECAPTCHA_SECRET_KEY` gesetzt ist
    (app.cg bleibt unverändert; gesetzter Key impliziert Provider recaptcha, solange
    `CAPTCHA_PROVIDER` nicht explizit gesetzt ist → keine Prod-Regression)
  - `off`: nur explizit (lokale Dev-Umgebung); lautes Warn-Log beim Start
- **Backend**
  - HMAC-Secret: aus Env/Docker-Secret, sonst automatisch generiert und persistiert
  - `GET /Captcha/challenge`: Challenge via `altcha-lib` (`createChallenge`, Ablaufzeit,
    sinnvolles `maxNumber` für Mobile-CPUs)
  - Verifikation via `verifySolution` + **Replay-Schutz** (Challenge-Signatur in Redis,
    SETNX + TTL) an beiden bestehenden Aufrufstellen (`srv/api/user.ts:117` und `:408`)
  - Joi-Validierung für alle neuen Payloads (Pflicht laut AGENTS.md)
- **Frontend**
  - `altcha`-Web-Component (npm) in `CaptchaModal` / `CaptchaContext` als zweiter Pfad
    neben reCAPTCHA; Provider kommt über die Instance-Config (`srv/util/instanceConfig.ts`
    → `src/common/instance.ts`)
  - `token:'stub'`-Pfad entfernen

## Status

- [x] Finding analysiert, Lösung gewählt (ALTCHA)
- [x] Implementierung auf Branch `feat/captcha-altcha` (von `develop`, 4 Commits, Typechecks grün)
- [x] Opus-Code-Review des Branches — 1 Blocker (Selfhost-CSP blockte ALTCHA-Worker) +
      Härtungspunkte, alle gefixt in `475925239`; Fail-closed-Logik, Replay-Schutz und
      HMAC-Handling vom Review als korrekt verifiziert
- [x] In `develop-merge` gemergt (2026-07-25, Merge-Commit `09e8cc3c1`)
- [x] PR-#38-Review-Blocker: Backend als Provider-Autorität (`GET /Captcha/config`),
      Misconfigured-Fehlerzustand in `SetupProfile`/`CaptchaModal`, Startup-Error-Log
      bei `recaptcha` ohne Secret-Key
- [ ] Laufzeit-Test im Browser beim nächsten lokalen Build (Solve→Verify→Replay; CSP-Fix
      verifizieren; PoW-Dauer auf schwachen Geräten — Default jetzt 500k Hashes)
- [ ] Klein (aus Review, optional): AltchaWidget-Listener wird bei jedem Render neu
      registriert; `CaptchaModal.onVerified` behandelt das verify-Promise nicht;
      Bestandscode loggt Captcha-Token bei Fehlern (`srv/api/user.ts` ~396)
- [ ] Selfhost-Doku (`docker/SELFHOST.md`) ergänzen
- [ ] PR gegen `develop`
