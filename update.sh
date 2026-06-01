#!/usr/bin/env bash
# WiDash — Update auf die neueste Version
# Lauf: ./update.sh

set -euo pipefail
cd "$(dirname "$0")"

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}WiDash — Update${RESET}"
echo "────────────────────────────────────"

# ── 1. Neuen Code holen ───────────────────────────────────────────────────────
echo ""
echo "▸ Hole neueste Version von GitHub…"
git pull --ff-only
echo -e "${GREEN}✓ Code aktualisiert${RESET}"

# ── 2. Python-Dependencies aktualisieren ─────────────────────────────────────
echo ""
echo "▸ Aktualisiere Python-Abhängigkeiten…"
source backend/.venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r backend/requirements.txt
deactivate
echo -e "${GREEN}✓ Python-Abhängigkeiten aktuell${RESET}"

# ── 3. Frontend-Dependencies aktualisieren ───────────────────────────────────
echo ""
echo "▸ Aktualisiere Frontend-Abhängigkeiten…"
cd frontend && bun install --silent && cd ..
echo -e "${GREEN}✓ Frontend-Abhängigkeiten aktuell${RESET}"

# ── Fertig ────────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────"
echo -e "${GREEN}${BOLD}✓ Update abgeschlossen!${RESET}"
echo ""
echo "WiDash starten:"
echo -e "  ${BOLD}./start.sh${RESET}"
echo ""
