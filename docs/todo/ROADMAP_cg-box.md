# Umzug nach cg.box — minimaler Ablauf

> Arbeitsstand: 2026-11-08. Entscheidungen und Fortschritt aus der Abstimmung mit
> Jan; Code/Skripte gegen `c18b233` plus Arbeitsänderungen geprüft. DB-Probeimport
> und Anwendungsstart auf cg.test am 2026-11-08 erfolgreich; cg.box noch nicht geprüft.
> **Diese Checkliste ist der aktuelle Plan und ersetzt abweichende Anforderungen
> der historischen Planung weiter unten.** Ziel: heute umziehen, sofern Probeimport
> und Abnahme erfolgreich sind. Nur umzugserforderliche Änderungen vorziehen.

## Beschlossen und bereits erledigt

- [x] Jan bestätigt alle von Opus angeforderten Browsertests als erfolgreich:
  Transfer-Session, Bestätigungsdialog, Security-Step und weitere S2-Testliste.
- [x] S2-Härtung und Gateway-Service-Worker sind in `develop` (`c18b233`, `77684f5`).
- [x] Dump vorhanden: `/home/jan/261108_prod.dump` (vollständiger Ersatzdump) auf der lokalen
  Entwicklungsmaschine, ca. 236 MiB, PostgreSQL-Custom-Format.
- [x] Hetzner-Server vorhanden; Jan hat Root-Zugang, `cg.box` zeigt bereits darauf.
  Laut Jan noch kein Anwendungsstack installiert.
- [x] Temporärer SFTP-Benutzer `cg-import` eingerichtet; Medien-Vorabkopie laut Jan
  am 2026-11-08 erfolgreich abgeschlossen.
  **Kein Speicherlimit, kein separates Dateisystem und kein zusätzlicher Kopieraufbau.**
- Alte VAPID-Schlüssel und Umzugs-Push entfallen vollständig. Eigene neue Schlüssel
  erzeugt der vorhandene Build; dafür kein eigenes Arbeitspaket beginnen.
- Monitoring, automatisierte Backups und Backup-Server folgen nach dem Umzug.
- Eigener Mailserver bleibt ausgeschaltet, sein Code bleibt erhalten. System-Mails
  gehen über SendGrid; Wochen-Digest und Community-Artikelnewsletter bleiben aus.
- `app.cg` und `id.app.cg` bleiben zunächst Login-/Transfer-Gateway, anschließend
  einfache Weiterleitung. Ende der Übergangsphase später festlegen.
- Updates manuell auslösen; vorhandenen Build-/Neustartablauf verwenden.
- Keine mehrtägige Softlaunch-Phase und kein vollständiges Rechtstextsystem vorziehen.

## 1. Auslieferungsstand abschließen

- [x] Abgenommene Transfer-Session-Änderungen als `53aba9b` in `develop` integriert;
  lokalen Arbeitsbranch gelöscht, ursprünglichen Worktree als detached Checkout erhalten.
- [x] Kleinen Newsletter-Schalter ergänzen (`CG_ENABLE_NEWSLETTERS=false`): Wochen-Digest und Community-Artikelversand
  deaktivierbar machen, einschließlich Anstoßen des Artikelversands. Pausierte Einträge
  nicht als versendet markieren. OTP, Verifikation, Sicherheitshinweise und sonstige
  System-Mails bleiben aktiv; Code und Abonnementeinstellungen bleiben erhalten.
- [x] Relevante Prüfungen: 17 Tests bestanden; Backend-/Frontend-Typechecks, gezielter
  ESLint-Lauf und Shell-Syntaxprüfung erfolgreich. Newsletter aus bei funktionierenden
  System-Mails geprüft. Kombinierter Stand mit Transfer-Änderungen: 154 Backend-Tests,
  sechs Reauth-Dialog-Tests und beide Typechecks erfolgreich. Deployment steht noch aus.
  Bereits bestandene unveränderte Browsertests nicht grundlos wiederholen.
- [x] Änderungen lokal in `develop` integriert: Transfer-Scope `53aba9b`, Newsletter-Pause
  und Importvorbereitung `70520b5`. Lokaler Transfer-Arbeitsbranch entfernt;
  auf GitHub existiert kein gleichnamiger Arbeitsbranch.
- [ ] GitHub-Push nach ausdrücklicher Freigabe (automatische Prüfung hat Push abgelehnt).
- [ ] Freigegebenen Stand gemäß bestehender Release-Entscheidung nach `main` übernehmen
  und auf cg.box ausliefern. Serverzugang bzw. Ausführung durch Jan noch abzustimmen.

## 2. Medienkopie — Vorabkopie abgeschlossen, S3-Import folgt

Quelle: alter SeaweedFS-Bucket `cg-media`, im Production-Container über `sw:` erreichbar.
Jans Momentaufnahme: **212.802 Objekte, 8.094.779.700 Bytes (7,539 GiB)**.
Ziel: `/srv/cg-import/upload/cg-media/` auf cg.box; für SFTP `/upload/cg-media`.
Zugangsdaten bleiben außerhalb dieser Datei.

Bereits gestarteter Befehl im alten Container:

```bash
rclone copy sw:cg-media \
  :sftp,host=cg.box,user=cg-import:/upload/cg-media \
  --sftp-ask-password \
  --sftp-known-hosts-file /root/.ssh/known_hosts \
  --sftp-disable-hashcheck \
  --transfers 4 \
  --progress
```

- [x] Vorabkopie laut Jan erfolgreich abgeschlossen (2026-11-08).
  `copy` löscht keine zusätzlichen Zieldateien; finaler Abgleich nach Schreibstopp folgt.
- [ ] Objekte später über die S3-Schnittstelle mit unveränderten Schlüsseln in das neue
  SeaweedFS übernehmen. **Die Ablage ist kein SeaweedFS-Volume.** Benötigte Metadaten,
  Bucket-/Datei-URL-Zuordnung sowie Vollständigkeit und Inhalt prüfen.
- [ ] Bilder und Downloads nach Import in der Anwendung testen. Finalen Abgleich nach
  Schreibstopp durchführen (Schritt 6); dann Objektanzahl und Größe neu messen.

## 3. Produktionsdump auf der lokalen cg.test-VM probeweise importieren

**Testziel ist die vorhandene lokale Test-VM**, nicht die Entwicklungsdatenbank oder
cg.box. **Lokal wird ausschließlich PostgreSQL getestet, kein S3/Medienimport.**
Der DB-Test kann vor Ende der Medienkopie beginnen. Testkonfiguration und
lokalen CA-Zugang erhalten.

- [x] Vorhandenen Dump auf die Test-VM kopiert, SHA-256 identisch; bisherige Test-DB
  und Konfiguration unter `/home/kaesual/import-test-2026-11-08/` gesichert.
- [x] Vollständiger Ersatzdump `261108_prod.dump`: PostgreSQL 14.6 (Ubuntu),
  Schema und Daten. Der frühere reine Datendump wurde durch diesen ersetzt.
- [x] Vorprüfung und Restore nach PostgreSQL 18.4 erfolgreich. Zusätzliche Besitzerrolle
  `cryptoadmin NOLOGIN` auf dem Ziel angelegt; `pgcrypto`/`pg_trgm` vorhanden.
  Alle 62 Quelltabellen stimmen vor Migration bei den Zeilenzahlen exakt überein
  (4.428.266 Zeilen insgesamt).
- [x] Drill hält SMTP ausgeschaltet; 4.338 importierte Push-Abonnements entfernt,
  alle 91.570 Geräte erhalten. Valkey-Sitzungen zurückgesetzt. Die Migration entfernt
  beide alten Verifikationscode-Spalten; kein zusätzlicher SQL-Nachlauf dafür nötig.
- [x] 23 Migrationen erfolgreich (149 → 172). Restore gesamt 34 s, darin
  `pg_restore` 11 s; separater Migrationsaufruf etwa 3 s. 65.672 Nutzer,
  1.958.524 Nachrichten, 6.246 Communities, 208.918 Dateieinträge und 1.565 Passkeys
  bleiben erhalten. Erwartete Änderungen: entfernte Wizard-/Assistant-Tabellen,
  33.234 Fuel-/Aeternity-Wallets sowie die bestehenden Bereinigungsmigrationen
  für Call-/Event-Berechtigungen. Neue Tabellen wurden angelegt.
- [x] Alle 1.565 Passkeys haben durch die Migration anhand ihrer gespeicherten
  Registrierungsdaten `rpId = 'id.app.cg'`, keine fehlende RP-Zuordnung oder doppelten
  Credential-IDs. Kein manueller Passkey-Nachlauf nötig. Ein echter WebAuthn-Login
  mit einem importierten Produktionspasskey wurde hier nicht durchgeführt.
- [x] Alle Indizes gültig, alle Constraints validiert; Lesen als `reader` und
  Schreiben als `writer` (mit anschließendem Rollback) erfolgreich.
- [ ] Gespeicherte Domain-/Dateiverweise untersuchen und nur erforderliche Anpassungen
  vornehmen; keine pauschale Textersetzung über die gesamte Datenbank. Geprüft:
  kein `files.objectId` enthält eine absolute URL; Medien selbst lokal nicht geprüft.
- [ ] Mit importierten Daten Login, Transfer, Security-Step, Communities und Nachrichten
  prüfen. Mail-Flows nur mit lokalem Mailfänger bzw. kontrollierten Testempfängern prüfen;
  die Drill-Konfiguration schaltet SMTP ab und muss dabei berücksichtigt werden.
- [x] Erfolgreiche DB-Importbefehlsfolge unten festgehalten. Vollständige Medienübernahme
  ist ein eigener Prüfschritt.
- [x] Stack wieder gestartet, alle Dienste mit Healthcheck gesund. Hauptinstanz und
  Gateway liefern ihre Konfiguration per HTTPS; Community-Liste mit importierten
  Daten liefert `OK`. Im Onchain-Dienst treten RPC-Zeitüberschreitungen auf;
  externe Blockchain-Anbindung ist damit noch nicht erfolgreich geprüft.

Vorhandener Einstieg: `docker/selfhost/selfhost.sh restore --db-file <Pfad>` mit
`--drill` und zunächst `--dry-run` auf der Test-VM. Nichtleere Ziele werden ohne
`--force` abgewiesen; diesen Zusatz erst für das bewusst gewählte, gesicherte Testziel
verwenden. Nach Restore läuft nur die DB; Migrationen vor regulärer Nutzung abschließen.
`--db-file` hat keinen automatischen Tabellenanzahlvergleich, daher oben separat prüfen.
Mit dem vollständigen Ersatzdump erfolgreich erprobt. [Restore-Dokumentation](../../docker/SELFHOST.md#only-the-database-from-a-dump-file).

### Erprobte Befehlsfolge auf cg.test

Im Repository auf der Test-VM; vorher Test-DB und private Konfiguration sichern.
Die Rolle nur anlegen, wenn sie auf dem Ziel noch fehlt:

```bash
./docker/selfhost/selfhost.sh compose exec -T db psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -c 'CREATE ROLE cryptoadmin NOLOGIN;'
./docker/selfhost/selfhost.sh restore \
  --db-file /home/kaesual/import-test-2026-11-08/production-full.dump \
  --force --drill --dry-run
./docker/selfhost/selfhost.sh restore \
  --db-file /home/kaesual/import-test-2026-11-08/production-full.dump \
  --force --drill
# Hier zuerst Zeilenzahlen gegen den Dump vergleichen, noch vor den Migrationen.
./docker/selfhost/selfhost.sh compose run --rm --no-deps -T migrate-db
# Hier RP-Zuordnung, Bestände und Bereinigung prüfen.
./docker/selfhost/selfhost.sh up
```

Private Belege: `/home/kaesual/import-test-2026-11-08/` enthält Quell-, Restore-
und Migrationszählungen, Logs, unveränderten Dump sowie die frühere Test-Sicherung.
**Für cg.box** finalen Dump-Pfad verwenden, `--drill` weglassen und alte
Push-Abonnements vor dem Anwendungsstart explizit entfernen:

```sql
UPDATE devices SET "webPushSubscription" = NULL
WHERE "webPushSubscription" IS NOT NULL;
```

Die Testzeiten sind keine Zusage für das gesamte Ausfallfenster: Medienabgleich,
Deployment, DNS und Abnahme kommen hinzu. Importierte Passkeys behalten ihre
Produktions-RP `id.app.cg`; `id.app.test` ist dafür keine austauschbare Origin.

## 4. cg.box und SendGrid vorbereiten

- [ ] Root-Zugang für die Einrichtung verfügbar machen; vorhandenen Selfhost-Stack
  installieren und freigegebenen Stand bauen. Bestehende Grundabsicherung nutzen,
  temporären Importzugang bis zum letzten Kopierlauf erhalten. Keine neue
  Infrastruktur-/Automatisierungsbaustelle beginnen.
- [ ] Domain, öffentliche IPv4, Calls und benötigte Integrationen konfigurieren;
  Gateway für `app.cg`/`id.app.cg` mit eigenen Session-Einstellungen vorbereiten.
- [ ] Jan authentifiziert `cg.box` bei SendGrid über dessen DNS-Vorgaben und erstellt
  einen separaten API-Key mit Mail-Send-Berechtigung.
- [ ] SMTP in der privaten `docker/.env.selfhost` konfigurieren:

```dotenv
CG_ENABLE_MAIL=false
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USER=apikey
SMTP_PASSWORD=<SendGrid-API-Key, nur in privater Konfiguration>
CG_ENABLE_NEWSLETTERS=false
EMAIL_FROM=no-reply@cg.box
EMAIL_FROM_NAME='Common Ground'
```

`CG_ENABLE_MAIL=false` deaktiviert den eigenen Relay-Container, **nicht** externes SMTP.
Der SMTP-Code ist vorhanden. **Zusätzlich den neuen Newsletter-Schalter aus Schritt 1
setzen, bevor produktive Daten mit aktivem Mailversand laufen.**
[SendGrid-SMTP-Konfiguration](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/integrating-with-the-smtp-api).

- [ ] OTP und System-Mail an ein kontrolliertes Konto tatsächlich zustellen; Absender
  und Links auf cg.box prüfen. Keine Newsletter-Testsendung an echte Listen.
- [ ] TLS auf cg.box prüfen; Zertifikatsausstellung für die Gateway-Domains zur
  DNS-Umschaltung vorbereiten. Benötigte Callback-/Origin-Freigaben anpassen.
- [ ] Rechtstexte minimal bereitstellen: bestehende Artikel aus dem Dump prüfen,
  öffentlich erreichbar machen und Links auf cg.box herstellen. Jan liefert nötige
  Ergänzungen/aktualisierte Texte. Kein vollständiges Instanz-Rechtstextsystem bauen.

## 5. Entscheidung zur Umschaltung

- [ ] Probeimport erfolgreich, Importbefehle und Dauer bekannt.
- [ ] Auslieferungsstand festgelegt; Newsletter aus, System-Mail getestet.
- [ ] Medienimport geprüft; finaler Abgleich ausführbar.
- [ ] Kurze Prüfung des Auslieferungsstands: Login/Transfer/Security-Step, Nachrichten,
  Upload/Download und Calls. Bestandene unveränderte Browser-/PWA-Tests gelten weiter;
  Änderungen gezielt nachtesten.
- [ ] Ausfallfenster nach gemessener Dauer festlegen und ankündigen. DNS-Ziele, bisherigen
  Stand und Rückweg für einen fehlgeschlagenen Start festhalten.

## 6. Finale Umschaltung — in dieser Reihenfolge

1. [ ] Alte Anwendung und schreibende Hintergrundjobs für Schreibzugriffe sperren.
   **Alten S3-Dienst und Kopiercontainer für den letzten Abgleich erreichbar halten.**
   Auch weitere Uploads über alte Endpunkte unterbinden.
2. [ ] Frischen finalen DB-Dump erstellen und unverändert aufbewahren; der Probedump
   ersetzt ihn nicht. Letzten Medienabgleich durchführen, inzwischen gelöschte Objekte
   berücksichtigen. Etwaige Löschungen zuerst als Vorschau prüfen; Quelle nicht bereinigen.
3. [ ] Finalen Dump auf cg.box mit geprobter Befehlsfolge importieren, Migrationen und
   Importnachlauf durchführen; finalen Medienbestand in SeaweedFS übernehmen. Alte
   Push-Abonnements ohne Löschen der Gerätezugänge entfernen. **Kein Drill-Modus in
   Produktion**, keine alten VAPID-Schlüssel, kein Umzugs-Push.
4. [ ] Daten/Konfiguration vor Freigabe prüfen; Hauptinstanz und Gateway starten.
   Newsletter bleiben aus, System-Mails über SendGrid aktiv.
5. [ ] `app.cg` und `id.app.cg` auf den neuen Server umstellen; `cg.box` zeigt schon
   dorthin. Alte Anwendungs-/Infrastruktur-Hostnamen gemäß Gateway-Plan stilllegen;
   erforderliche Mail-/Domainverifikations-DNS-Einträge nicht pauschal löschen.
6. [ ] Zertifikate, Dienste/Logs, Login/Transfer, OTP, Nachrichten, Medien und Calls prüfen;
   alte installierte PWA muss das Gateway erreichen. Alten Stack während der
   DNS-Übergangszeit weiterhin für Schreibzugriffe gesperrt lassen.
7. [ ] Freigabezeitpunkt festhalten. Alten Stack, finalen Dump und Quelldaten zunächst
   behalten. Vor neuen Nutzerschreibzugriffen ist Rückkehr zum alten Stand möglich;
   danach nicht einfach DNS zurückdrehen, sondern zuerst neue Daten berücksichtigen.
8. [ ] Nach letztem Medienabgleich temporären Importzugang sperren und bestehende
   Sitzungen beenden. Ablage erst nach verifiziertem Import entfernen.

## 7. Nach dem Umzug — keine Voraussetzung für die Umschaltung

- [ ] Tägliches Backup auf cg.box mit vorhandenen Werkzeugen einrichten. Ein separater
  Backup-Server holt abgeschlossene Backups täglich per SSH/SCP ab; Jan kümmert sich
  anschließend um diesen Server. Format, Aufbewahrung und konsistenten Abruf dann
  festlegen. Automatischer Abruf ist noch nicht implementiert.
- [ ] Monitoring später festlegen/einrichten; Telegram ist heute keine Voraussetzung.
- [ ] Eigenen Mailserver/Newsletter später wieder aufnehmen; Code jetzt behalten.
- [ ] Manuellen Updateablauf dokumentieren: vorhandenes `selfhost.sh update` führt
  Pull, Build und Neustart aus.
- [ ] Ende der Gateway-Phase und Weiterleitung festlegen. Umgang mit Domainregistrierungen
  separat klären; den heutigen Umzug dafür nicht aufhalten.
- [ ] Nach Abschluss Erkenntnisse in dauerhafte Dokumentation übernehmen, Folgearbeiten
  auslagern und diese Arbeitsroadmap löschen.

## Ergebnisprotokoll

| Punkt | Ergebnis |
|---|---|
| Auslieferungscommit | Kandidat `70520b5` lokal auf `develop`; enthält Transfer-Scope `53aba9b`, Push und Serverdeployment offen |
| Newsletter-Schalter / Produktionswert | `CG_ENABLE_NEWSLETTERS=false`; implementiert, Deployment offen |
| Probedump-Pfad auf cg.test / SHA-256 | `/home/kaesual/import-test-2026-11-08/production-full.dump`; `a1f17f13fbea9c147df6f9857913f405d0d624098c98425bb58296c6e4152b6f`; vollständiger Dump erfolgreich importiert |
| Restore-Dauer / Migrationsdauer | 34 s gesamt (pg_restore 11 s) / ca. 3 s für 23 Migrationen |
| Geprüfte Importbefehlsfolge | Vollständiger Restore und Migrationen erfolgreich; 62 Tabellen vor Migration exakt gezählt, Passkey-Zuordnung vollständig; HTTPS-/Community-Smokecheck erfolgreich, manueller Login mit importiertem Konto offen |
| Medien-Vorabkopie / Prüfung | Laut Jan erfolgreich abgeschlossen; Import in neues SeaweedFS und Medienprüfung offen |
| SendGrid-Zustellung | offen |
| Finaler Dump / Medienabgleich | offen |
| Umschaltung / Freigabezeitpunkt | offen |

---

## Historische Planung bis 2026-11-07

Die folgenden Phasen dokumentieren Vorarbeiten und frühere Entscheidungen.
Offene Kästchen hier sind **keine zusätzliche Startbedingung**. Für die weitere
Arbeit gilt die Checkliste oben. Frühere Merge-/Teststände können überholt sein;
insbesondere sind Umzugs-Push, eigener Mailserver, Monitoring, Backup-Automatisierung
und mehrtägiger Softlaunch keine Voraussetzungen mehr. Die frühere Agentenaufteilung
beschreibt vergangene Arbeit und ist kein aktueller Delegationsauftrag.

> Umbrella roadmap for moving the hosted Common Ground instance from `app.cg`
> (Docker Swarm, `production` branch) to **`cg.box`** (one server, self-host
> profile, `develop` branch), plus the infrastructure and security work that has
> to land first. Living document; supersedes the 2026-10-22 platform-ops
> planning, whose decisions are carried over below. Delete this file when the move is done and `app.cg` is shut down; the
> post-move items (P7) graduate into their own roadmaps or TODO.md.
>
> Historical scope; superseded by the minimal checklist of 2026-11-08 above.

## Target picture

```
            ┌──────────────────── one server ─────────────────────────┐
cg.box ─────┤ Caddy ─► main instance (develop: api, wsapi, jobs, …)   │
            │   │                         │                           │
app.cg ─────┤   └────► gateway instance ──┴── same Postgres / Valkey / │
id.app.cg ──┤          (develop, gateway mode)   SeaweedFS             │
            └─────────────────────────────────────────────────────────┘
```

- **cg.box** is a fresh instance on `develop`, restored from a backup of the
  current production data (Postgres + S3) and migrated forward.
- For a transition period **app.cg and id.app.cg point at the same server**.
  There a minimal **"login & migrate" gateway** runs: users log in exactly as
  before — device key (silent), passkey (rpID `id.app.cg`), wallet, email,
  password — and get a **one-time link** that logs them in on cg.box. cg.box then
  requires them to set up a login method that works there (and an email) before
  they get in.
- After the transition period app.cg is shut down. Users who did not move by then
  lose access; the active user base is expected to have moved.
- The `production` branch and the Azure/Swarm pipeline are **not touched**: the
  old stack is switched off after the final backup.

## Decisions

2026-10-22 (from the platform-ops planning):

1. Container runtime on targets: **Docker Compose** (self-host profile). Target
   OS: Ubuntu LTS / Debian 13.
2. **nginx is replaced by Caddy** in the self-host profile **and** the dev stack,
   so routing lives in one place.
3. **7-day minimum release age for every ecosystem** (npm, Docker images, apt,
   pip/Galaxy, CI). Exceptions only with explicit maintainer approval, recorded
   with date, package/version and reason. Amended 2026-10-31: **security fixes**
   (an update resolving a published advisory) need only **3 days**
   (docs/infrastructure/UPDATE-POLICY.md).
4. **Redis → Valkey.**
5. Images are built on the server. Prebuilt images (GitHub Actions + GHCR) and the
   Ansible management suite (Ansible in a pinned container, `cg.sh`/`cg.ps1`) come
   after the move — except backup/restore, which is needed before it.

2026-10-28:

6. Merge to `develop` without PRs where the maintainer says so; housekeeping via
   git.
7. The **seven deferred major updates are part of this work** (Express 5,
   react-router 7, Tailwind 4, Vite 8, TypeORM 1.x, joi 18, TypeScript 6).

2026-10-31:

8. **Gateway instead of a read-only mode** on the old stack (target picture above).
   No Bot API forwarding is needed — the production release has no Bot API.
9. **Passkeys for cg.box are registered on the main origin** (rpID `cg.box`), with
   no popup or redirect to an `id.` subdomain. There is no `id.cg.box`. The
   account-creation UI gets reworked in the same go.
10. **Email: the app speaks SMTP only** (nodemailer, replacing SendGrid; Mailchimp
    goes). The stack ships an **optional send-only mail container** (compose
    profile, switchable off) and the operator can point the app at any SMTP
    server instead. (Revises the 2026-08-02 "no MTA in the stack" decision.)
11. A **dress rehearsal with real production data** happens well before move day,
    on the test VM; the final dump is taken on move day.
12. app.cg is kept only for the transition period.

2026-11-01:

13. **Node 26** (LTS since 2026-10, support until ~2029) for the new deployment;
    Node 24 is the fallback only if mediasoup or a native module blocks.
14. **Renovate runs as the Mend GitHub app** (free for public repos, no own
    infrastructure, opens PRs only — nothing auto-merges).
15. **`main` stays the GitHub default branch**; `develop` is the development
    branch, and the deployment is later made from `main` (after `develop` is
    merged into it). Renovate therefore reads a stub `renovate.json` on `main`
    that points it at `develop`, where the real config lives
    (docs/infrastructure/UPDATE-POLICY.md). Dependabot alerts are on.
16. **No hotfixes on app.cg** for issues found during this work: the
    `production` branch stays untouched until the move.
17. **Calls are on at cg.box launch.**
18. **Sign-in methods added during a transfer session are full methods** once
    added (no probation period); the notices to the verified address are the
    safeguard. Whoever holds the old login has the account on app.cg anyway.
19. **The account-security step may link a new wallet**, not only one that is
    already linked.
20. **Email-code login only to verified addresses**; users whose address was
    never confirmed can have the confirmation sent again.
21. **Sign-up and login must never lock out a person who makes mistakes**:
    limits only against volumes that look like abuse, every limit message says
    how long to wait and what else to do (Auth UX package, G10).
22. **Email codes have 8 digits, and code-login failure budgets reset hourly**
    (10 per network, 30 overall per address): a lockout of someone else's code
    login lasts at most an hour, and the longer code keeps guessing harder
    than the earlier daily budget with 6 digits did (2026-11-01).

2026-11-07:

23. **The production server exists and is sized**: an existing machine at the
    existing hoster (data processing agreement in place), freshly set up with
    Ubuntu 26.04 LTS — the same release as the test VM —, 8 cores, 16 GB RAM,
    240 GB SSD, **IPv4 only** (no AAAA records). Its address is known to the
    maintainer and only becomes public with the DNS records.
24. **S3 objects are copied by the maintainer straight from the production
    storage to the new server**, not through a local backup; they are static,
    so a first copy ahead of time plus a delta sync on move day is enough. A
    production **database dump** for the restore test comes from the maintainer.
25. **The transition period lasts months**: the gateway runs until app.cg's
    registration ends (see the open question on P7).
26. **Legal pages become instance settings** (G14); today's texts are community
    articles on production, the maintainer provides copies.
27. **Monitoring: the simplest solution that works, alerts to a Telegram bot
    and channel** (S4).
28. **Operator duties (S6)** are handled by the maintainer with Florian (legal).
29. **Administration and updates with as little effort as possible**: the
    server runs the self-host profile (`selfhost.sh`, `harden.sh`,
    `backup.sh`); the Ansible suite still comes after the move (decision 5).
30. **A transfer session adds sign-in methods only while the account is in the
    account-security step**; for a complete account it is an ordinary sign-in,
    and changes to sign-in methods need the usual re-authentication (narrows
    decision 18). (Implemented 2026-11-07: a transfer session counts only for
    what the account lacks at the time of the request; docs/auth-identity §7,
    §11, §12.)
31. **The DNS zone of app.cg is cut down to `app.cg` and `id.app.cg` on move
    day**, not before: the other records still serve the running production
    instance until then (P6).

## Phases

Order: P0 → P1 → (P2 ∥ P3) → P4 → P5 → P6. Work inside a phase runs in parallel
branches. Each item follows the usual cycle (branch from `develop` → implement →
independent review → maintainer go → merge → delete branch).

### Lanes (how the work is parallelized)

Claude coordinates: work packages go to implementing agents, each result gets an
independent review, then a test-VM acceptance where it touches the stack, then
the maintainer's go for merge + push (ready branches are presented in batches).
Lanes are cut by **file ownership**, so parallel branches rarely conflict:

| Lane | Owns | Sequence |
|---|---|---|
| **A Infra** | `docker/`, Dockerfiles, compose files, Caddy, shell scripts | F1+F2 → F3 ∥ F4 → F5 → F7 → F8 |
| **B Dependencies** | `package.json` / `yarn.lock` of all workspaces | after F1+F2 are merged (age gate, Node 26): F6 → M1 → M2 → M3 → M4 |
| **C Move features** | backend auth/APIs, login and account UI | starts now: G8 → G4 → G2+G3 → G1 → G5, G6, G7, G9 |
| **D Security** | the private findings list (not in this repo) | starts now: S1 triage; fixes are slotted into A/B/C |
| **Maintainer** | outside the repo | Renovate app, server order, DNS, legal (S6), production dump |

Serialization points (one at a time, coordinated by Claude):

- **Dev stack**: every checkout on the dev VM shares the compose project `docker`
  (volumes, ports), so only one lane runs the stack; agents in worktrees build
  and test in throwaway containers with their own project names.
- **Builds**: a frontend build peaks at ~4 GB; the dev VM (16 GB, 4 cores) takes
  about two concurrent heavy builds.
- **Test VM**: one acceptance run at a time.
- **Lockfile**: lane C's new packages (e.g. nodemailer, WebAuthn) land as small
  separate commits that are merged first, so lane B rebases on them.
- **Merges to `develop`**: one at a time; open branches rebase afterwards.

Start set: A (F1+F2), C (G8), D (S1) — two to three implementing agents at once,
plus reviews. Lane B starts when F1+F2 are merged.

### P0 — Housekeeping

- [x] This roadmap committed; `ROADMAP_dependency-updates.md`,
  `ROADMAP_REFERENCE_CLIENT.md` and `ROADMAP_IMAGE_FILTER.md` dissolved into
  docs/ and TODO.md; hosted-Swarm-only TODO items marked superseded.
- [x] Issue #53 follow-up merged (`a5633d5be`); merged remote branches deleted
  (12 on 2026-10-28).
- [x] Delete the six remaining remote branches (squash-merged into develop,
  verified 2026-10-31 by a trial merge that leaves develop's tree unchanged).
- [x] `docker/.env` untracked: template `docker/.env.example` + first-run
  generator `docker/ensureEnv.sh` (merged 2026-10-31, `3925a78`).
- [x] Dev VM access to GitHub via per-repo deploy keys; `main`/`develop`
  protected against force pushes and deletion (ruleset).
- [ ] Reply to issue #87 (external contributor, call reliability) — draft by
  Claude, posted by the maintainer. Mention the ICE-TCP and startup-order fixes
  merged 2026-10-28.

### P1 — Foundation

- [x] **F1 Update policy.** (done 2026-10-31: `docs/infrastructure/UPDATE-POLICY.md`, `renovate.json`, verified binary downloads) Policy document in docs/infrastructure (7-day rule,
  exception log, mechanisms: Yarn `npmMinimalAgeGate`/`npmPreapprovedPackages`,
  Renovate `minimumReleaseAge`). Renovate config for the Mend GitHub app
  (decision 14; the maintainer installs the app). `yarn --immutable` in every Dockerfile; lockfile for
  `docker/hardhat/node`; narrow `approvedGitRepositories`. Checksums for binary
  downloads where feasible (mediasoup worker, Chrome for Testing for puppeteer,
  bcrypt prebuilds).
- [x] **F2 Base images and tooling.** (done 2026-10-31: Node 26.12.0 on trixie,
  every image digest-pinned, apt via `snapshot.debian.org`, Yarn 4.18.1;
  accepted on the test VM as an in-place upgrade.) Pin every image by version + digest. Node 26
  (decision 13) — verify mediasoup and the native modules (bcrypt, sharp,
  onnxruntime) build and run. Debian base `bookworm` → `trixie` (bookworm has
  been on LTS only since 2026-06-11, until 2028-06-30). apt via dated
  snapshot or exact versions. SeaweedFS and Caddy current. Yarn 4.17.1 → current
  4.x (update the `packageManager` field incl. its hash) — all under the 7-day
  rule; binary checksums as in F1.
- [x] **F3 PostgreSQL 14 → 18.** (done 2026-10-31: `cryptogram/db:18` on
  postgres 18.4, rewritten `postgresql.conf`, `init.sh` creates the mediasoup
  role; the 14 → 18 restore path is documented in docs/database and was
  rehearsed on the test VM with identical row counts.) Scope cut by the
  maintainer: no upgrade scripts — dev volumes are recreated, cg.box is a
  restore into a fresh cluster. Follow-up: 18.6 once it passes the age gate.
- [x] **F4 Redis 6.2 → Valkey.** (done 2026-10-31: Valkey 9.1.2 as a persistent
  `noeviction` state instance plus an LRU cache instance, lazy clients with
  error listeners and MULTI timeouts; accepted on the test VM.) Follow-up:
  store only real sessions (docs/todo/TODO.md). Sessions, socket.io adapter, cached data; verify
  node-redis / connect-redis / `@socket.io/redis-adapter` against Valkey. Keep
  sessions safe from cache memory pressure (separate instance or eviction
  policy per use) and give every client an error listener.
- [x] **F5 Caddy replaces nginx** (done 2026-10-31; accepted on the test VM incl.
  the upgrade path from an nginx install) (self-host + dev). Custom Caddy image carrying
  the frontend dist and the instance-config injection. Reproduce every nginx rule
  in order: `/files/` S3-presign rewrite (exact `Host <host>:8333`), `/api/v2/`
  allowlist strip-prefix, `/api/bot/v1/` → `/BotV1/`, `/api/ws/`, share/OG
  routes, the `/community/<url>` redirect, static
  assets with long-lived `immutable` caching for the content-hashed files under
  `static/` (nginx caps them at `max-age=86400, must-revalidate` today), SPA fallback with `no-cache`
  shell, COOP/COEP pages, CSP + security headers, the CG-ID-origin CORS headers
  (needed by the gateway's `id.app.cg`), `request_body max_size 16MB`,
  trusted-proxy / `X-Forwarded-For` handling (the rate limiter keys on it). Add HSTS
  (no preload at first). Let's Encrypt in production, `tls internal` for local
  instances. Dev stack: Caddy `tls internal` instead of nginx + self-signed certs;
  `run.sh` commands keep working; the Vite dev server on :3000 is unchanged.
  Update `tools/checkHtmlRewriteCompat.mjs`, the
  conformance compose file, build scripts and docs. Acceptance: conformance suite
  green + browser pass on the test VM. The CG ID vhost is no longer needed on
  cg.box (decision 9) but **is** needed for the gateway's `id.app.cg` (see G1;
  the TODO.md item on pruning the CG ID vhost's cross-origin allowances applies
  here). The hosted Swarm nginx configs are deleted together with the Swarm
  pipeline after the move (P7).
- [x] **F6 npm security + in-major refresh** (done 2026-10-31; remaining
  advisories and holds in docs/infrastructure/UPDATE-POLICY.md; unused Truffle
  devDependencies removed) of all workspaces under the age gate
  (`yarn npm audit` clean or every remaining advisory documented). Includes the
  Hardhat 2.29 bump from TODO.md ("Optional").
- [x] **F7 Self-host leftovers.** Build ID no longer written into the tracked
  `src/common/random_build_id.ts`; a real healthcheck (`startHealthcheck` in
  `srv/healthcheck.ts` has no callers, every process uses `fakeHealthcheck()` —
  wire the real one up or delete it, and move `fakeHealthcheck` into its own
  module so `memberlist` stops opening Redis connections it never uses); Docker
  log rotation; per-container resource limits; IPv6 address detection; drop the `docker-compose` v1 fallback in
  `selfhost.sh` (v1 ignores `COMPOSE_PROFILES`, so `calls`/`blockchain` would
  silently not start) (done 2026-11-06, `170a73b`: the build ID is set at
  build time and shared by frontend and backend; real health checks of every
  backend service's connections; backend services start only after `migrate-db`
  completed; per-service memory limits and log rotation; `init.sh` recommends an
  A record only, IPv6 stays a later step; the v1 fallback is gone; accepted on
  the test VM.)
- [x] **F8 Backup / restore.** `selfhost.sh backup|restore` (or scripts):
  Postgres custom-format dump, SeaweedFS data, encrypted secrets bundle
  (`.env.selfhost`, `vapid_keys.json`, `s3_config/`, certs), retention,
  systemd timer, **off-server copy** (e.g. restic to a storage box). Done only
  after a restore onto a fresh test VM was rehearsed. (done 2026-11-01:
  `selfhost.sh backup|restore` via restic, `docker pause` of `seaweed` for the
  media copy, Valkey not backed up, `caddy-data` and the DKIM key included;
  drill mode, timeline guard (`--take-over`), undoable restores; the restore
  rehearsal on the wiped test VM passed — new-server restore, rollback and
  `--undo`, see `docs/deployment/README.md` §3.7 — and its findings are fixed.
  The production-sized timing comes with the dress rehearsal.)

### P2 — Major-version waves (after F6)

One branch per wave, each verified with typecheck, lint, tests, conformance suite
and a browser pass on the test VM:

- [x] **M1** TypeScript 6, joi 18 (done 2026-10-31: TypeScript 6.0.3 and joi 18.3.1
  in every workspace, tsconfigs migrated; accepted on the test VM)
- [x] **M2** Express 5, TypeORM 1.x (done 2026-11-01 in two steps: Express 5.3.0
  merged first, then TypeORM 1.1.2; TypeORM runs only in `migrate-db` and the
  CLI, the schema of a fresh database is identical and nothing re-runs on an
  existing one; e2e and conformance match the baseline)
- [x] **M3** react-router 7, Vite 8 (done 2026-11-02: Vite 8.3.5 and react-router
  7.18.4; the service worker reads cached scripts into memory before handing
  them over, which fixed intermittent start-up failures with Vite 8's finer
  chunking; accepted on the test VM)
- [x] **M4** Tailwind 4 (visual regressions — screenshot comparison of key views)
  (done 2026-11-02: Tailwind CSS 4.3.3 with its configuration in
  `src/tailwind.css`; the browser floor is now Safari 15.4, Chrome/Edge 104,
  Firefox 97; the screenshot comparison of the key views is identical to the
  Tailwind 3 build; accepted on the test VM)

### P3 — Move features (parallel to P2)

- [x] **G1 Gateway mode.** The `develop` backend + frontend started a second time
  with `BASE_URL=https://app.cg`, `CGID_URL=https://id.app.cg` and a gateway flag,
  on the same database/Valkey/S3. Server-side **endpoint allowlist** (login
  methods incl. CGID passkey assertion, session, transfer-link creation; nothing
  else) — enforced in the backend, not just hidden in the UI. Frontend: after
  login only the "Common Ground moved to cg.box" screen. Deep links: after the
  transfer, `app.cg/<path>` lands on `cg.box/<path>`. Session cookie host-only on
  `app.cg`; the CG ID app reaches the session through its same-site requests
  to `app.cg`. Because the gateway needs the CGID passkey flow for rpID `id.app.cg`,
  the CGID app can only be removed from the code base **after** the gateway is
  gone (P7). The gateway gets its own session secret, session-store prefix and
  Socket.IO adapter key (a cookie from one origin must not work on the other);
  singleton processes (`job-runner`, `onchain`, `memberlist`) run only for
  cg.box; one env-driven CORS/origin allowlist (if it names request headers, it
  must allow `x-cg-socket-id`, which the client sends on every API request —
  docs/realtime "Socket-scoped targeting"); the login methods it exposes
  are hardened before it goes live (S1 tracks which). Acceptance: the gateway
  runs with `CG_LEGACY_CGID=true` on **every** backend process, and legacy mode
  keeps the full previous sign-up/login surface — so the server-side allowlist
  is the only thing standing between the gateway and that surface; test it
  against the complete route list. (Done 2026-11-07, `696102b`, accepted on the
  test VM: `CG_GATEWAY` with the selfhost profile `gateway` (`gateway-api`,
  `gateway-wsapi`); a 19-route API allowlist and a two-event socket allowlist,
  checked against every mounted route; own secret and `gateway:` prefix, shared
  mail-limit secret, start-up config checks; the gateway page keeps no local
  data and continues by itself only after a sign-in in the same tab;
  docs/auth-identity §12, SELFHOST.md.)
- [x] **G2 Transfer link.** One-time token: random, stored hashed with user id,
  ~10 min expiry, single use; carried in the URL fragment
  (`https://cg.box/transfer#<token>`) so it never reaches logs or `Referer`;
  redeemed by a POST from the cg.box frontend. Rate-limited. (Done 2026-11-01,
  accepted on the test VM: `User/createTransferLink` — on only
  with `TRANSFER_TARGET_URL`, for the session's own user —, `previewTransferLink`,
  `redeemTransferLink` (one conditional `UPDATE`, logged-out sessions only,
  `authMethod: 'transfer'`), the `/transfer` confirmation page with name, handle
  and image; docs/auth-identity §11. G1 sets `TRANSFER_TARGET_URL` on the gateway
  and allowlists `User/createTransferLink`.)
- [x] **G3 Account-security step on cg.box.** A user arriving via transfer link
  (and any user without a working login method on cg.box) must add one before
  using the app: passkey on cg.box, password, or a wallet (decision 19); plus a
  verified email. A server-side password policy comes with it, plus throttling
  of password and email-code login and a bcrypt cost review. Decide here whether stricter requirements against bots apply to
  new sign-ups too (email verification is cheap once mail runs on our side).
  (Done 2026-11-01, accepted on the test VM: the step is derived
  from the account and enforced by the api, wsapi and the call server; adding
  what is missing needs a sign-in within the hour; password policy = 8
  characters, bcrypt cost 12 with rehash; failure-based login throttles; email
  codes bound to their address and account, email-code login only to verified
  addresses with "send confirmation again" for signed-in users (decision 20);
  X/LUKSO/Farcaster-only accounts must add a passkey, password or wallet; methods
  added in a transfer session are full methods, notices to the verified address
  are the safeguard (decision 18; a transfer session adds them only during the
  step, decision 30). Anti-bot: nothing beyond G4's verified
  address and captcha. docs/auth-identity §5, §8, §11.)
- [x] **G11 Session cookie on expired sessions.** When the session has expired
  at page load, parallel requests mint new anonymous sessions whose cookies can
  overwrite the one the automatic device login just set (the e2e reload flow's
  `cookie-cleared`/`session-expired` modes show it). Anonymous requests should
  not create sessions (`saveUninitialized: false` or equivalent), verified with
  the e2e reload flow (done 2026-11-01: `saveUninitialized: false`, cookies
  rolled only for logged-in sessions, revoked session ids after logout and
  re-login are never written back or re-sent, the legacy CG ID popup result
  goes to a per-request socket room instead of the session room; e2e reload
  flow 0/40 failures, before 6/40.)
- [x] **G12 Session housekeeping.** Changing credentials signs out the other
  devices: replacing the password or the verified email and removing a
  sign-in method end every other session of the user and delete every other
  device key (adding a way in does not, so the transfer flow and the
  account-security step leave the other devices alone); an explicit "Sign out
  other devices" in Settings → Accounts (step-up, says how many); the signed-out
  devices get `cliSignedOut` and drop to logged-out with a notice. Mechanism:
  per-account session generations in PostgreSQL (one sequence; raised in the
  transaction of the change; device keys and transfer links carry theirs and
  are checked in the SQL that looks them up; a login takes its value before
  the credential check; sessions are checked against a copy in Valkey that a
  reconciler keeps in step every 30 s) plus an index of each user's sessions
  (`sess-user:`) to end and count them through G11's revocation; unused
  transfer links are deleted; prepared wallet signatures are re-checked at
  login. Pre-login sessions live an hour in the store (12 hours from login on, sign-up state keeps
  its session as long as it needs it), and every endpoint that starts one is
  limited per network (decision 21). docs/auth-identity §2, §4. (done
  2026-11-01; race tests against real PostgreSQL 18 and Valkey 9 with the
  application roles.)
- [x] **G4 Passkeys on the main origin + new account-creation UI.** (done
  2026-10-31: passkeys bound to their RP (`rpId` per row; `id.app.cg` rows are
  gateway-only), one login form with passkey autofill, sign-up with the email
  verified before the account exists, step-up for sensitive actions,
  last-login-method guard, `/login`; X/LUKSO/Farcaster only linkable in
  settings, recovery-phrase login only in legacy mode; accepted on the test VM.
  Decisions: no compatibility mode for self-host `id.<domain>` passkeys, no
  separate gateway-only flag.)
  rpID =
  cg.box host, ceremonies run in the main app (conditional UI / passkey autofill
  on the login form; step-up re-authentication for destructive actions such as
  deleting a community becomes a simple in-page prompt). New account-creation /
  login UI. Old `id.app.cg` passkeys stay valid on the gateway only. Take the
  TODO.md item "Passkey ceremony foot-guns in the CGID flow" into account when
  the ceremonies move.
- [ ] **G5 Import routine.** (Passkey rows of the dump get `rpId = 'id.app.cg'`; assert none stays NULL.) Restore the production dump into Postgres 18, run the
  develop migrations, then a post-import step (sessions live in Redis/Valkey,
  not in the dump, so they start empty anyway): keep `devices` and
  old passkeys (the gateway needs them) but mark old passkeys as gateway-only,
  rewrite absolute `app.cg` URLs in stored content
  (TODO(verify): where absolute URLs are stored), copy S3 objects into SeaweedFS
  (TODO(verify): which storage production uses and the data volume). Idempotent
  and scripted; part of the backup/restore tooling.
- [ ] **G6 Service worker on app.cg.** The new server serves, at the old service
  worker URL, a worker that replaces the old PWA: clears the old caches, takes
  control and loads the gateway. Must be tested with a browser that has the old
  app installed (P5). (Implementation done 2026-11-07, branch
  `feature/sw-replacement`: the old worker URL is `/service-worker.js`, scope
  `/`; the gateway's site serves `docker/caddy/gateway-service-worker.js` there
  — skipWaiting, deletes every cache, claims, reloads the pages the old worker
  controlled, no fetch handler, shows pushes in the old format; the gateway
  page registers the same file, so nothing loops; e2e `gateway` flow with a
  stand-in for the old worker; docs/frontend "Service worker on a gateway".
  Open: the browser test in P5, procedure in docs/deployment §3.13.)
- [ ] **G7 Farewell push.** One-off script that sends "Common Ground moved" to
  every stored push subscription, in the payload format of the **old** service
  worker, signed with the **old VAPID key pair** (must come with the production
  secrets); removes expired subscriptions. Old subscriptions are not usable for
  cg.box — users re-subscribe there (part of G3). The key pair is the `api`
  service's secret `vapid_keys_json` (`/run/secrets/vapid_keys_json` inside a
  running `api` container: JSON with `publicKey` and `privateKey`; Swarm does not
  show a secret's value through `docker secret inspect`). The replacement worker
  of G6 shows the push and opens `navUrl` only as a path on its own origin (an
  absolute cg.box URL becomes `/`); a push to a device whose app was not opened
  since the DNS switch also triggers the worker update, which installs the
  replacement.
- [x] **G8 Mail.** (done 2026-10-31: nodemailer + optional maddy relay with bounce policy, send limits, one-click unsubscribe; accepted on the test VM; real delivery to Gmail/Outlook, PTR and outbound port 25 are checked on a public server before move day, P5) SMTP via nodemailer instead of SendGrid (the swap point is
  `EmailUtils.sendEmail` in `srv/api/emails.ts` + init in `srv/serverconfig.ts`),
  Mailchimp removed. Optional send-only MTA container (compose profile `mail`,
  e.g. Postfix or Maddy): persistent queue with retries (greylisting), DKIM
  signing with the key kept out of the app containers, one egress point for
  port 25. `CG_ENABLE_MAIL=false` + `SMTP_*` settings for an external server.
  Docs for SPF, DKIM, DMARC, PTR/rDNS, outbound port 25 at the hoster, and
  one-click unsubscribe for notification mails.
- [ ] **G9 Domain-specific leftovers.** `og:site_name` hardcoded to `app.cg` in
  `index.html` (every self-hosted instance ships it in social previews — drop the
  tag or rewrite it in the instance-config injection like the other social meta);
  external service settings for cg.box: Twitter callback URL,
  WalletConnect origin allowlist, email sender domain. (The code part is done
  2026-11-06, `170a73b`: `og:site_name` and the embedding hints name the
  instance's own host. Open: the external service settings, with the server.)
- [x] **G10 Auth UX.** Walk every login and sign-up path on the test VM with a
  screenshot of each step and each error message; rework from the maintainer's
  notes. Limits per decision 21 (account creation per network far above 2 per
  day; the server returns the remaining wait time and the UI shows it with an
  alternative path, a countdown on "send again"); input errors caught in the
  form before anything reaches the server. After G2+G3. (done 2026-11-01:
  account creation 20/h and 50/day per network, checked before the code is
  sent; every limit answer carries `retryAfterSeconds` and the kind of limit,
  the UI shows the wait and another way in; countdowns on "send again"; input
  checks in the forms; 8-digit email codes and hourly code-login failure
  budgets per the maintainer's review of the screenshot walkthrough.)
- [ ] **G14 Legal pages and official-site links.** Privacy policy, terms of use,
  legal notice and help as instance settings (Markdown text or an external
  URL), shown by every instance instead of links to the official instance's
  community articles; one constant for the official site (`https://cg.box`) for
  the remaining links to it. The texts come from today's production articles
  (decision 26). Inventory (moved here from TODO.md, found in G9): privacy policy,
  terms of use and help (`src/views/Home/Home.tsx`), "get started"
  (`src/views/Home/Banner.tsx`), the feedback channel (`FeedbackPage.tsx`), the
  support channel (`CommunityViewSidebar.tsx`), learn-more articles
  (`HowSparkWorks.tsx`, `PremiumManagement.tsx`, `RolesManagement.tsx`,
  `NewslettersManagement.tsx`, `PluginEditor.tsx`, `PluginAppstore.tsx` — the last
  also three sample articles on `staging.app.cg` —, `TokenSale.tsx`,
  `IdentitiesEditor.tsx`). Not part of it: the legacy domain logic
  (`src/data/util/urls.ts`, `authMode.ts`, `common/config.ts`, `srv/util/urls.ts`),
  the Matomo snippet in `src/index.tsx` (runs only without an instance config),
  the dead Fractal link in `IdentitiesEditor.tsx`.
- [x] **G13 Runtime fixes.** Long-standing defects found in a 2026-11-02
  analysis: inline backgrounds without an image URL request `…/undefined`;
  calls whose call server goes away are never ended (no periodic sweep), so
  they linger on the home page; the server-side last-read time of a channel
  can move backwards; call role setup builds invalid SQL when no role
  permissions are passed; a scheduled call's duration is added as milliseconds.
  The client message cache and the tab/socket hand-off are replaced in a
  separate package (chat-sync, branch `feature/chat-sync`; the result is
  described in docs/frontend "Chat stores" and docs/realtime "Tab
  Coordination"); G6 waits for it, since both touch the service worker.
  (done 2026-11-02: calls on a gone call server are ended by a periodic
  sweep, event calls included, and every end reaches clients; an ended event
  call can be started again; the last-read time only moves forward and never
  into the future; inline backgrounds without a URL paint `none`; accepted on
  the test VM)

### P4 — Security gate (before the rehearsal is signed off)

- [x] **S1 Findings triage.** The private findings list is triaged against the
  new stack; whatever applies and blocks the move is fixed (tracked privately).
  (Triage done 2026-10-31; the move-blocking fixes were merged the same day
  with `fix/hardening-batch-1`, the rest is slotted into the items above.)
- [ ] **S2 Review of the new code** (gateway, transfer link, account-security
  step, passkeys on the main origin, mail) — independent security review.
  (Review done 2026-11-07; resulting changes on `fix/s2-review`, not merged
  yet. What holds with them: LUKSO sign-in takes a SIWE-format message naming
  this instance; both session cookies are host-only; a transfer link's next
  path is always a same-site path, the confirmation page shows a unique
  identifier of the account, "This isn't me" and a gateway sign-out use the
  account's open links up; gateway settings start only in gateway mode and
  never with `DEPLOYMENT=dev`; event change/cancellation mails have a budget;
  the self-host builder has its own network; secret files are mode 600;
  `harden.sh` part `mail25` limits outgoing port 25 to the relay. Still to do
  by the maintainer: the old domain's DNS reduced to `app.cg` and `id.app.cg`
  before the gateway takes real sign-ins (SELFHOST.md, "Old host names");
  `mail25` and the seaweed config copy on the test VM; a LUKSO sign-in with a
  real Universal Profile on the test VM.)
- [ ] **S3 Server hardening.** SSH key-only login, firewall (only 22, 80,
  443 tcp+udp (HTTP/3), 4443, 40000–40099 udp+tcp; note that Docker-published ports bypass ufw — publish
  nothing else), unattended security upgrades, log rotation. Reserve the
  mediasoup port range (`net.ipv4.ip_local_reserved_ports = 40000-40099`): it
  overlaps the ephemeral port range, and a collision stops `mediasoup` from
  starting (docker/SELFHOST.md). Set `vm.overcommit_memory = 1` (Valkey
  background saves fork). (Script done 2026-11-06, `170a73b`:
  `docker/selfhost/harden.sh` with `--dry-run`/`--skip`; security updates of the
  distribution install right away, see UPDATE-POLICY.md; run on the test VM
  without the SSH part. Open: the full run on the new server.)
- [ ] **S4 Monitoring.** External uptime check; alerts for disk space, certificate
  expiry, container health, failed backups; alerts go to a Telegram bot and
  channel (decision 27).
- [ ] **S5 DNS.** CAA record (Let's Encrypt only); lowered TTL on app.cg ahead of
  the move; HSTS without preload first.
- [ ] **S6 Operator duties** (maintainer, not code): legal notice and privacy
  policy for cg.box (new hoster → data processing agreement; own mail sending
  changes data flows), DSA notice-and-action contact and reporting process.

### P5 — Dress rehearsal (test VM)

- [ ] Production dump (DB + S3) from the maintainer — a few weeks old is fine;
  deleted from the test VM afterwards.
- [ ] Full run on the test VM with `cg.test` as the new domain and `app.test` /
  `id.app.test` as stand-ins for the old ones (Caddy `tls internal`, hosts file):
  import (G5), gateway, transfer link, account-security step, farewell push
  against a test subscription, service-worker replacement with a browser that has
  the old production app installed (served under `app.test` before the switch;
  the old build carries absolute `https://app.cg` URLs, so docs/deployment §3.13
  installs it from the live `app.cg` in a separate profile and points `app.cg`
  at the test VM by hosts file instead — procedure there).
- [x] Backup → restore onto a freshly reset test VM (F8; passed 2026-11-01).
- [ ] One real Let's Encrypt run on a publicly reachable server (the test VM only
  exercises `tls internal`), so the ACME path is proven before move day.
- [ ] Time the import, so move-day downtime can be announced.
  Includes the migrations that run on the old data for the first time
  (`chatSyncSeq`, `syncStateIndexes`, `permissionDataCleanup`: indexes and data
  changes in one transaction).
- [ ] No mail or push reaches real users during the rehearsal; the import clears
  stored verification and one-time codes.
- [ ] Repeat until clean; write the move-day runbook from it.

### P6 — Move

- [x] Server ordered and sized (decision 23).
- [ ] Base setup per S3 (`harden.sh` including SSH), Docker, first `selfhost.sh`
  run for cg.box; S3 objects copied ahead of time (decision 24).
- [ ] Soft launch: cg.box running for the team for a few days (fresh data).
- [ ] Announcement with the downtime window.
- [ ] Move day per runbook: stop the old stack → final dump → import → DNS for
  app.cg / id.app.cg / cg.box, and every other record under app.cg removed
  (decision 31) → checks → farewell push.
- [ ] Transition period (length to decide), then P7.

### P7 — After the move

- [ ] app.cg / id.app.cg shut down as instances; both domains **stay registered**
  and only serve a plain redirect to cg.box (whoever registered a lapsed domain
  could serve installed PWAs and the old passkey origin). Gateway mode, CGID app,
  old passkeys and old push subscriptions removed from code and data.
- [ ] Azure pipelines, Swarm stack files and hosted nginx configs deleted. Before
  that, the reference-client pipeline (`pipelines/reference-client-conformance.yml`:
  OpenAPI drift check + conformance suite) moves to GitHub Actions, or both stop
  running — see TODO.md.
- [ ] The `/e/*` → `/` route for the ecosystem URLs removed in 2026-08 is
  dropped (`src/App.tsx`).
- [ ] Ansible management suite (`cg setup`, backup/restore, update/status/logs/
  config), GHCR images, VM-based development environment for contributors
  (`cg dev-setup`) — own roadmaps.

## Open questions

- P7 says app.cg and id.app.cg **stay registered** after the move (whoever takes
  over a lapsed domain could serve installed PWAs and the old passkey origin);
  decision 25 lets the gateway run until app.cg's registration ends. Keep the
  registrations with a plain redirect afterwards, or let them lapse?
- The size of the S3 data (it shares the 240 GB disk with the database, local
  backups and images) and the off-server target for backups
  (`CG_BACKUP_REPOSITORY`, any restic backend).

## Test infrastructure

| VM | Purpose | Lifecycle |
|---|---|---|
| **dev VM** | daily development: checkout, dev stack, Claude Code, VS Code Remote-SSH (4 cores, 16 GB RAM) | long-lived |
| **test VM** | self-host acceptance, rehearsal, backup/restore | disposable: snapshot of a fresh Ubuntu Server 26.04, reverted before each from-scratch run |

Test VM sizing: ≥ 4 cores, 8 GB RAM, 40 GB disk; SSH key login for a sudo user;
UDP 40000–40099 and TCP 4443 reachable from the maintainer's browser for call
tests.

The test VM is reached from the maintainer's workstation via hosts-file names
(`cg.test`, `app.test`, `id.app.test`) and a persistent local root CA kept on the
dev VM, seeded into Caddy after each reset (procedure in `docker/SELFHOST.md`,
"Local test instance"). Code reaches it as a `git archive` of the branch under
test — no push needed.
