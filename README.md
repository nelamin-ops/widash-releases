# WiDash

Lokales RMA-Dashboard für DCEng-Engineers. Verbindet sich über die Salesforce CLI mit GUS, zeigt Coolan-Komponenten und den Master-Patchplan — alles lokal auf deinem Mac, keine Cloud.

---

## Voraussetzungen

Einmalig prüfen ob folgendes installiert ist:

**Python 3.11**
```bash
python3.11 --version
```
Nicht vorhanden → [python.org/downloads](https://www.python.org/downloads/) oder `brew install python@3.11`

**Salesforce CLI**
```bash
sf --version
```
Nicht vorhanden → [developer.salesforce.com/tools/salesforcecli](https://developer.salesforce.com/tools/salesforcecli)

**Git**
```bash
git --version
```
Auf dem Mac normalerweise vorinstalliert.

---

## Installation

### Schritt 1 — Repo herunterladen

Terminal öffnen (Spotlight → „Terminal") und folgendes eingeben:

```bash
git clone https://github.com/nelamin-ops/widash-releases.git
cd widash-releases
```

### Schritt 2 — Installieren

```bash
./install.sh
```

Das Script richtet alles automatisch ein (Python-Umgebung, Frontend-Abhängigkeiten, Ordnerstruktur). Dauert ca. 1–2 Minuten.

### Schritt 3 — Salesforce einloggen

```bash
sf org login web
```

Ein Browser öffnet sich — normal mit deinen Salesforce-Zugangsdaten einloggen, dann Fenster schließen. Dieser Schritt ist nötig damit WiDash auf GUS zugreifen kann. Die Zugangsdaten verlassen deinen Mac nicht.

### Schritt 4 — WiDash starten

```bash
./start.sh
```

Der Browser öffnet sich automatisch mit dem Dashboard auf `http://localhost:5173`.

Beim ersten Start erscheint das **Region Settings**-Fenster — dort deinen GUS RMA-Report auswählen oder die Report-ID eingeben.

---

## Tägliche Nutzung

**Starten:**
```bash
cd widash-releases
./start.sh
```

**Stoppen:** `Ctrl+C` im Terminal

**Salesforce-Session abgelaufen?** (roter Banner im Dashboard)
```bash
sf org login web
```
Danach im Dashboard auf „Retry" klicken.

---

## Updates

Wenn eine neue Version verfügbar ist, erscheint im Dashboard oben ein Banner.

Update durchführen:
```bash
cd widash-releases
./update.sh
```

Danach `./start.sh` wie gewohnt.

---

## Patchplan einrichten (optional)

Für die Connections-Sektion in Ticket-Sheets brauchst du lokale CSV-Exports des Master Patchplans:

1. Master Patchplan in Google Sheets öffnen
2. Für jeden Tab: **Datei → Herunterladen → CSV**
3. Alle CSVs in diesen Ordner legen:
```
~/Library/Application Support/WiDash/patchplan/
```
4. Dashboard neu laden — Connections erscheint automatisch

---

## Probleme?

| Problem | Lösung |
|---|---|
| `python3.11: command not found` | Python 3.11 installieren (siehe oben) |
| `sf: command not found` | Salesforce CLI installieren (siehe oben) |
| Weißer Bildschirm | Tab neu laden mit `⌘R` |
| Dashboard leer / Fehler | `sf org login web` im Terminal ausführen |
| Port bereits belegt | `./start.sh` erneut ausführen (beendet alte Prozesse automatisch) |

Fragen oder Probleme → Najih El Amin
