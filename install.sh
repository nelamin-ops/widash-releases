#!/usr/bin/env bash
# WiDash — Einmalige Installation
# Lauf: ./install.sh

set -euo pipefail
cd "$(dirname "$0")"

BOLD="\033[1m"
GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[0;33m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}WiDash — Installation${RESET}"
echo "────────────────────────────────────"

# ── 1. Python 3.11 ───────────────────────────────────────────────────────────
echo ""
echo "▸ Prüfe Python 3.11…"
if ! command -v python3.11 &>/dev/null; then
  echo -e "${RED}✗ Python 3.11 nicht gefunden.${RESET}"
  echo "  Bitte Python 3.11 installieren: https://www.python.org/downloads/"
  echo "  Oder über Homebrew: brew install python@3.11"
  exit 1
fi
PY_VERSION=$(python3.11 --version)
echo -e "${GREEN}✓ ${PY_VERSION}${RESET}"

# ── 2. Bun ───────────────────────────────────────────────────────────────────
echo ""
echo "▸ Prüfe Bun…"
if ! command -v bun &>/dev/null; then
  echo -e "${YELLOW}⚠ Bun nicht gefunden — wird jetzt installiert…${RESET}"
  curl -fsSL https://bun.sh/install | bash
  # Reload PATH so the rest of this script can use bun
  export PATH="$HOME/.bun/bin:$PATH"
fi
BUN_VERSION=$(bun --version)
echo -e "${GREEN}✓ Bun ${BUN_VERSION}${RESET}"

# ── 3. sf CLI ────────────────────────────────────────────────────────────────
echo ""
echo "▸ Prüfe Salesforce CLI…"
if ! command -v sf &>/dev/null; then
  echo -e "${RED}✗ Salesforce CLI (sf) nicht gefunden.${RESET}"
  echo "  Bitte sf CLI installieren: https://developer.salesforce.com/tools/salesforcecli"
  exit 1
fi
SF_VERSION=$(sf --version 2>&1 | head -1)
echo -e "${GREEN}✓ ${SF_VERSION}${RESET}"

# ── 4. Python venv + Dependencies ────────────────────────────────────────────
echo ""
echo "▸ Richte Python-Umgebung ein…"
if [ ! -d "backend/.venv" ]; then
  python3.11 -m venv backend/.venv
fi
source backend/.venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r backend/requirements.txt
deactivate
echo -e "${GREEN}✓ Python-Abhängigkeiten installiert${RESET}"

# ── 5. Frontend Dependencies ─────────────────────────────────────────────────
echo ""
echo "▸ Installiere Frontend-Abhängigkeiten…"
cd frontend && bun install --silent && cd ..
echo -e "${GREEN}✓ Frontend-Abhängigkeiten installiert${RESET}"

# ── 6. Patchplan-Verzeichnis anlegen ─────────────────────────────────────────
PATCHPLAN_DIR="$HOME/Library/Application Support/WiDash/patchplan"
if [ ! -d "$PATCHPLAN_DIR" ]; then
  mkdir -p "$PATCHPLAN_DIR"
  echo -e "${GREEN}✓ Patchplan-Ordner angelegt: ${PATCHPLAN_DIR}${RESET}"
else
  echo -e "${GREEN}✓ Patchplan-Ordner vorhanden${RESET}"
fi

# ── Fertig ────────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────"
echo -e "${GREEN}${BOLD}✓ Installation abgeschlossen!${RESET}"
echo ""
echo "Nächster Schritt — Salesforce einloggen:"
echo -e "  ${BOLD}sf org login web${RESET}"
echo ""
echo "Danach WiDash starten:"
echo -e "  ${BOLD}./start.sh${RESET}"
echo ""
