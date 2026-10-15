#!/usr/bin/env python3
"""Convert the National Shipping Ledger workbook into JSON for the app's import endpoint.

Usage:  python3 tools/ledger_to_json.py National_Shipping_Ledger.xlsx > import.json
        node tools/import.js import.json          (or Admin > Import in the app)

Reads VESSEL MOVEMENTS and EXTENSION LOG. Rotation numbers are rebuilt the same way the
workbook builds them, so the imported records keep the numbers already printed on paperwork.
"""
import datetime as dt
import json
import sys
import warnings

import openpyxl

warnings.filterwarnings("ignore")

CLASS = {
    "Container Vessel": "CRG", "General Cargo Vessel": "CRG", "Supply Vessel": "SUP", "Oil/Fuel Tanker": "TKR",
    "Pleasure Vessel / Yacht": "PSV", "Cruise Ship": "CRU", "Military / Government Vessel": "GOV",
    "Bulk Carrier": "BLK", "Ro-Ro Vessel": "ROR", "Fishing Vessel": "FSH", "Research / Survey Vessel": "RSV",
    "Other": "OTH", "Liveaboard": "LVB",
}
COLS = ["vessel_type", "_class", "_seq", "station", "voyage_no", "vessel_name", "imo", "flag", "agent",
        "gross_tonnage", "net_tonnage", "crew", "passengers", "master", "last_port", "arrival_date",
        "boarding_officer", "next_port", "departure_date", "clearance_officer", "cargo"]


def iso(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, str) and v.strip():
        for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d"):
            try:
                return dt.datetime.strptime(v.strip(), fmt).strftime("%Y-%m-%d")
            except ValueError:
                pass
    return None


def clean(v):
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def main(path):
    wb = openpyxl.load_workbook(path, data_only=False)
    vm = wb["VESSEL MOVEMENTS"]
    default_year = int(vm["B4"].value or dt.date.today().year)
    calls, auto = [], {}
    for row in vm.iter_rows(min_row=6):
        vals = {COLS[i]: row[i].value for i in range(len(COLS))}
        if not clean(vals["vessel_name"]):
            continue
        vtype = (clean(vals["vessel_type"]) or "Other")
        cls = CLASS.get(vtype, "OTH")  # the workbook falls back to OTH for unlisted types
        arrival = iso(vals["arrival_date"])
        year = int(arrival[:4]) if arrival else default_year
        seq = vals["_seq"]
        if cls != "CRG" or isinstance(seq, str) and seq.startswith("="):
            auto[year] = auto.get(year, 0) + 1  # shared annual sequence for all non-CRG calls
            seq = auto[year]
        rec = {k: clean(v) for k, v in vals.items() if not k.startswith("_")}
        rec.update(row=row[0].row, vessel_type=vtype, arrival_date=arrival, departure_date=iso(vals["departure_date"]),
                   rotation_no=f"{year}/{cls}/{int(seq)}" if seq not in (None, "") else None)
        remarks = row[23].value  # column X
        rec["remarks"] = None if isinstance(remarks, str) and remarks.startswith("=") else clean(remarks)
        for k in ("imo", "voyage_no"):
            if rec.get(k) is not None:
                rec[k] = str(rec[k])
        calls.append(rec)

    exts = []
    el = wb["EXTENSION LOG"]
    for row in el.iter_rows(min_row=5):
        rot = clean(row[0].value)
        if not rot:
            continue
        exts.append({"rotation_no": rot, "date_granted": iso(row[4].value), "original_expiry": iso(row[5].value),
                     "new_expiry": iso(row[6].value), "approved_by": clean(row[7].value), "reason": clean(row[8].value),
                     "remarks": clean(row[9].value)})
    json.dump({"calls": calls, "extensions": exts}, sys.stdout, indent=1, default=str)


if __name__ == "__main__":
    main(sys.argv[1])
