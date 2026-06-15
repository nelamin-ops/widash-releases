"""Quick one-off diagnostic for mom.dmz integration.

Calls fetch_overview / fetch_rack_devices and prints a summary so we
can see whether ES + Argus are reachable + joining correctly.

Usage (from repo root, with backend/.venv active):
    python -m backend._debug_mom_overview FRA3
    python -m backend._debug_mom_overview FRA3 G35
"""
from __future__ import annotations

import json
import sys

from . import mom_client


def main() -> None:
    site = sys.argv[1] if len(sys.argv) > 1 else "FRA3"
    rack = sys.argv[2] if len(sys.argv) > 2 else None

    print(f"=== fetch_overview(site={site}) ===")
    rooms = mom_client.fetch_overview(site=site)
    for room in rooms:
        racks = room["racks"]
        temps = [r["tempC"] for r in racks if r["tempC"] is not None]
        print(
            f"  room {room['name']}: {len(racks)} racks "
            f"(temps known for {len(temps)}, "
            f"max {max(temps) if temps else '-'}°C)"
        )
        for r in racks[:3]:
            print(
                f"    {r['label']:>4}  "
                f"{r['tempC'] if r['tempC'] is not None else '?':>5}°C  "
                f"{r['fullValue']}"
            )
        if len(racks) > 3:
            print(f"    … {len(racks) - 3} more")

    if rack:
        print(f"\n=== fetch_rack_devices(site={site}, rack={rack}) ===")
        devs = mom_client.fetch_rack_devices(site=site, rack=rack)
        print(f"  {len(devs)} devices")
        for d in devs:
            print(
                f"    pos {d['pos']:>3}  "
                f"{d['tempC'] if d['tempC'] is not None else '?':>5}°C  "
                f"{d['device']}"
            )


if __name__ == "__main__":
    main()
