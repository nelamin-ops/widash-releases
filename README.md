# WiDash

A local RMA dashboard for DCEng engineers. Connects to GUS via the Salesforce CLI, shows Coolan components and the master patchplan — everything runs locally on your Mac, no cloud involved.

---

## Prerequisites

Check that the following are installed:

**Python 3.11**
```bash
python3.11 --version
```
Not found → [python.org/downloads](https://www.python.org/downloads/) or `brew install python@3.11`

**Salesforce CLI**
```bash
sf --version
```
Not found → [developer.salesforce.com/tools/salesforcecli](https://developer.salesforce.com/tools/salesforcecli)

**Git**
```bash
git --version
```
Usually pre-installed on macOS.

---

## Installation

### Step 1 — Clone the repo

Open a Terminal (Spotlight → "Terminal") and run:

```bash
git clone https://github.com/nelamin-ops/widash-releases.git
cd widash-releases
```

### Step 2 — Run the installer

```bash
./install.sh
```

This sets up everything automatically (Python environment, frontend dependencies, folder structure). Takes about 1–2 minutes.

### Step 3 — Log in to Salesforce

```bash
sf org login web
```

A browser window opens — log in with your Salesforce credentials, then close the tab. This is required so WiDash can access GUS. Your credentials never leave your Mac.

### Step 4 — Start WiDash

```bash
./start.sh
```

Your browser opens automatically with the dashboard at `http://localhost:5173`.

On first launch the **Region Settings** dialog appears — select your GUS RMA report from the dropdown or enter your report ID manually.

---

## Daily use

**Start:**
```bash
cd widash-releases
./start.sh
```

**Stop:** `Ctrl+C` in the terminal

**Salesforce session expired?** (red banner in the dashboard)
```bash
sf org login web
```
Then click "Retry" in the dashboard.

---

## Updates

When a new version is available, a banner appears at the top of the dashboard.

To update:
```bash
cd widash-releases
./update.sh
```

Then start as usual with `./start.sh`.

---

## Patchplan setup (optional)

To use the Connections section in ticket sheets, you need local CSV exports of the master patchplan:

1. Open the master patchplan in Google Sheets
2. For each tab: **File → Download → CSV**
3. Place all CSVs in this folder:
```
~/Library/Application Support/WiDash/patchplan/
```
4. Reload the dashboard — Connections will appear automatically in ticket sheets

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `python3.11: command not found` | Install Python 3.11 (see above) |
| `sf: command not found` | Install Salesforce CLI (see above) |
| White screen | Reload the tab with `⌘R` |
| Dashboard empty / error | Run `sf org login web` in the terminal |
| Port already in use | Run `./start.sh` again (kills stale processes automatically) |

Questions or issues → Najih El Amin
