#!/usr/bin/env python3
"""
Build lib/server/seed-data.json from the research snapshots (2026-10-15).

  repair.csv  — Samsung India "Mobile Spare Part Cost" page, parsed (official list
                prices: excl. GST, labour and consumables; premium colour / max storage).
  lineup.csv  — samsung.com/in selling prices for phones on sale.

Everything that is NOT from those sources is labelled: release years and update
policy years are approximate; the trade-in rate card is a SAMPLE.
"""
import csv, json, re, sys, os

SRC_DIR = sys.argv[1] if len(sys.argv) > 1 else "scripts"
OUT = sys.argv[2] if len(sys.argv) > 2 else "lib/server/seed-data.json"
OBSERVED = "2026-10-15"
SPARE_URL = "https://www.samsung.com/in/support/spare-part-pricing-list-for-repair/"
THIS_YEAR = 2026

def slug(name):
    n = re.sub(r"\(.*?\)", "", name)
    n = re.sub(r"\b\d+GB\b", "", n)
    n = n.replace("+", " plus ")
    n = re.sub(r"[^A-Za-z0-9]+", "-", n).strip("-").lower()
    return n

def clean_name(name):
    n = re.sub(r"\s*\(.*?\)", "", name).strip()
    n = re.sub(r"\s+\d+GB\b", "", n)
    return n

def model_codes(name):
    """Samsung model codes in the official name, e.g. "Galaxy S22 (SM-S901E)" -> ["SM-S901E"].
    Android reports the same code as Build.MODEL; SwapUp Check matches on it
    (exact code, or the 7-character family "SM-S901" that SM-S901B shares)."""
    out = []
    for group in re.findall(r"\((.*?)\)", name):
        for code in re.findall(r"SM-[A-Z0-9]+", group.upper()):
            if code not in out:
                out.append(code)
    return out

def series_of(model):
    m = model.replace("Galaxy ", "")
    if m.startswith("Z "): return "Z"
    return m[0]

def release_year(model):
    m = model.replace("Galaxy ", "")
    if re.match(r"S2\d", m):
        n = int(m[1:3])
        if "FE" in m and n == 21: return 2022
        return 2000 + n
    z = re.match(r"Z (Fold|Flip)(\d)", m)
    if z: return 2018 + int(z.group(2))
    if re.match(r"F70", m) or m.startswith("M47") or m.startswith("M17e"): return 2026
    if "2021 Edition" in m: return 2021
    x = re.match(r"([AMF])(\d)(\d)", m)
    if x: return 2019 + int(x.group(3))
    return None

def security_years(model, year):
    m = model.replace("Galaxy ", "")
    s = series_of(model)
    if s == "S": return 7 if year >= 2024 else 5
    if s == "Z": return 7 if year >= 2024 else 5
    if year >= 2025: return 6
    if year == 2024: return 5
    if year == 2023: return 4 if re.match(r"(A14|F04|M04)$", m.split()[0]) and "5G" not in m else 5
    if year == 2022: return 5 if re.match(r"(A33|A53|A73|M33|M53)", m) else 4
    return 4

def tier(model):
    s = series_of(model)
    return "Z" if s == "Z" else "S" if s == "S" else "other"

CARE = {  # ADLD processing fee per repair event (tax incl.), Samsung Care+ smartphone terms PDF / web table
    "Galaxy Z Fold4": 10999, "Galaxy Z Fold5": 10999, "Galaxy Z Fold6": 10999, "Galaxy Z Fold7": 10999,
    "Galaxy Z Flip4": 9249, "Galaxy Z Flip5": 9249, "Galaxy Z Flip6": 9249, "Galaxy Z Flip7": 9249, "Galaxy Z Flip7 FE": 9249,
    "Galaxy S26": 3699, "Galaxy S25": 3699, "Galaxy S26 Ultra": 3699, "Galaxy S26+": 3699, "Galaxy S25 Ultra": 3699,
    "Galaxy S25+": 3699, "Galaxy S25 Edge": 3699, "Galaxy S24 Ultra": 3699, "Galaxy S23": 3699,
    "Galaxy S25 FE": 2349, "Galaxy A56 5G": 2349, "Galaxy S24+": 2349, "Galaxy S24": 2349, "Galaxy S24 FE": 2349, "Galaxy S23 FE": 2349,
}

def variants_for(model):
    m = model.replace("Galaxy ", "")
    s = series_of(model)
    if s == "Z": return ["128GB", "256GB"] if "Flip4" in m else ["256GB", "512GB"]
    if s == "S":
        if "Ultra" in m or "+" in m or "Edge" in m: return ["256GB", "512GB"]
        return ["128GB", "256GB"]
    x = re.match(r"[AMF](\d)(\d)", m)
    if x and int(x.group(1)) >= 3: return ["128GB", "256GB"]
    return ["64GB", "128GB"]

def launch_class(model):
    m = model.replace("Galaxy ", "")
    s = series_of(model)
    if s == "S":
        if "Ultra" in m: return 125000
        if "Edge" in m: return 110000
        if "+" in m: return 90000
        if "FE" in m: return 55000
        return 75000
    if s == "Z":
        if "Fold" in m: return 200000 if "Ultra" in m else 155000
        return 90000 if "FE" in m else 95000
    if m.startswith("F70"): return 30000
    if m.startswith("M47"): return 26000
    x = re.match(r"([AMF])(\d)(\d)", m)
    if not x: return 15000
    fam, d = x.group(1), int(x.group(2))
    if fam == "A": return {0: 11000, 1: 15000, 2: 20000, 3: 28000, 5: 38000, 7: 42000}.get(d, 20000)
    return {0: 9000, 1: 12000, 2: 15000, 3: 18000, 4: 22000, 5: 26000, 6: 24000}.get(d, 15000)

RESIDUAL = {0: 0.65, 1: 0.52, 2: 0.42, 3: 0.32, 4: 0.24, 5: 0.18}

def sample_prices(launch, year, variants):
    age = max(0, THIS_YEAR - year)
    base = launch * RESIDUAL.get(age, 0.13)
    return {v: int(round(base * (1 + 0.08 * i) / 100.0) * 100) for i, v in enumerate(variants)}

# ── Samsung models + repair book from the official page ─────────────────
models = {}
repair = []
best_display = {}
with open(os.path.join(SRC_DIR, "research-samsung-spare-parts-2026-10-15.csv")) as f:
    for row in csv.DictReader(f):
        name = row["model"]
        if name == "ALL models" or not row.get("price_inr") or not row["price_inr"].strip().isdigit():
            continue
        model = clean_name(name)
        mid = slug(name)
        if mid not in models:
            y = release_year(model)
            if y is None:
                continue
            sec = security_years(model, y)
            models[mid] = {
                "id": mid, "brand": "Samsung", "model": model.replace("Galaxy ", "Galaxy "), "series": series_of(model),
                "releaseYear": y, "supportEndYear": y + sec, "variants": variants_for(model), "serviceTier": tier(model),
                "carePlusFee": CARE.get(model), "modelCodes": [], "source": {"kind": "oem_public", "label": f"Release year and update policy approximate ({sec} yrs security) — check Samsung's security-update scope page", "observedAt": OBSERVED},
            }
        for code in model_codes(name):
            if code not in models[mid]["modelCodes"]:
                models[mid]["modelCodes"].append(code)
        part, price = row["part"], int(row["price_inr"])
        src = {"kind": "oem_public", "url": SPARE_URL, "observedAt": OBSERVED}
        label_base = "Samsung India list price, excl. GST & labour (premium colour / max storage)"
        if part in ("screen_main_assembly", "screen_component_main_screen_oled", "screen_component_repair"):
            rank = {"screen_main_assembly": 0, "screen_component_main_screen_oled": 1, "screen_component_repair": 2}[part]
            cur = best_display.get(mid)
            if cur is None or rank < cur[0]:
                what = {0: "Main Screen Assembly", 1: "Screen Component — Main Screen", 2: "Screen Component Repair"}[rank]
                best_display[mid] = (rank, price, {**src, "label": f"{label_base} — {what}"})
            continue
        mapped = {"battery": "battery", "back_glass_cover": "back_cover", "rear_camera": "rear_camera", "front_camera": "front_camera"}.get(part)
        if not mapped or price < 100:   # a camera under ₹100 is a data error on the source page
            continue
        if any(r["modelId"] == mid and r["part"] == mapped for r in repair):
            continue
        repair.append({"modelId": mid, "part": mapped, "price": price, "source": {**src, "label": label_base}})
for mid, (_, price, src) in best_display.items():
    repair.append({"modelId": mid, "part": "display", "price": price, "source": src})

# ── other brands customers trade in toward a Samsung (not serviced here) ──
OTHER = [
    ("Apple", "iPhone 11", 2019, 65000), ("Apple", "iPhone 12", 2020, 70000), ("Apple", "iPhone 13", 2021, 70000),
    ("Apple", "iPhone 13 Pro", 2021, 120000), ("Apple", "iPhone 14", 2022, 80000), ("Apple", "iPhone 14 Pro", 2022, 130000),
    ("Apple", "iPhone 15", 2023, 80000), ("Apple", "iPhone 15 Pro", 2023, 135000), ("Apple", "iPhone 16", 2024, 80000),
    ("OnePlus", "OnePlus 9", 2021, 50000), ("OnePlus", "OnePlus 10R", 2022, 38000), ("OnePlus", "OnePlus 11", 2023, 57000),
    ("OnePlus", "OnePlus 12", 2024, 65000), ("OnePlus", "OnePlus Nord CE 3", 2023, 27000),
    ("Xiaomi", "Redmi Note 11", 2022, 14000), ("Xiaomi", "Redmi Note 12", 2023, 17000), ("Xiaomi", "Redmi Note 13 Pro", 2024, 26000),
    ("Vivo", "Vivo V27", 2023, 33000), ("Vivo", "Vivo V29", 2023, 33000), ("Oppo", "Oppo Reno 8", 2022, 30000), ("Oppo", "Oppo Reno 10", 2023, 33000),
    ("Google", "Pixel 6a", 2022, 44000), ("Google", "Pixel 7", 2022, 60000), ("Google", "Pixel 8", 2023, 76000),
]
PIXEL_SEC = {"Pixel 6a": 5, "Pixel 7": 5, "Pixel 8": 7}
other_launch = {}
for brand, model, y, launch in OTHER:
    mid = slug(model if brand != "Apple" else model)
    sec = PIXEL_SEC.get(model)
    models[mid] = {
        "id": mid, "brand": brand, "model": model, "series": None, "releaseYear": y,
        "supportEndYear": (y + sec) if sec else None, "variants": ["128GB", "256GB"], "serviceTier": "other", "carePlusFee": None, "modelCodes": [],
        "source": {"kind": "sample", "label": "Release year approximate; update policy not recorded" if not sec else f"Google update policy ({sec} yrs), release year approximate", "observedAt": OBSERVED},
    }
    other_launch[mid] = launch

# ── SAMPLE rate card (illustrative, never a Cashify price) ──────────────
entries = []
for mid, m in models.items():
    launch = other_launch.get(mid) or launch_class("Galaxy " + m["model"].replace("Galaxy ", ""))
    if m["brand"] == "Apple":
        launch = int(launch * 1.4)  # iPhones hold resale value better — still a SAMPLE
    for v, p in sample_prices(launch, m["releaseYear"], m["variants"]).items():
        if p >= 500:
            entries.append({"modelId": mid, "variant": v, "maxPrice": p})

# ── new devices from samsung.com/in selling prices ──────────────────────
new = []
NEW_SEC = lambda model, year: 7 if series_of(model) in ("S", "Z") else (4 if "A06" in model else 6)
NEW_YEAR = {"S25": 2025, "S26": 2026, "Z Flip7": 2025, "Z Fold7": 2025, "Z Flip8": 2026, "Z Fold8": 2026,
            "A06": 2024, "A07": 2025, "A08": 2026, "A17": 2025, "A27": 2026, "A36": 2025, "A37": 2026, "A56": 2025, "A57": 2026,
            "M08": 2026, "M17e": 2026, "M47": 2026, "M17": 2025, "F08": 2026, "F17": 2025, "F36": 2025, "F70": 2026}
with open(os.path.join(SRC_DIR, "research-samsung-lineup-2026-10-15.csv")) as f:
    order = 0
    seen = set()
    for row in csv.DictReader(f):
        if row["price_type"] != "selling" or "Re-Newed" in row["model"]:
            continue
        # The verifier relabelled these two rows: news-reported list prices, not
        # prices samsung.com/in was selling at on the day.
        if (row["model"], row["variant"]) in {("Galaxy S26+", "12GB+512GB"), ("Galaxy S26 Ultra", "16GB+1TB")}:
            continue
        model = row["model"].strip()
        key = (model, row["variant"])
        if key in seen:
            continue
        seen.add(key)
        short = model.replace("Galaxy ", "")
        year = next((y for k, y in sorted(NEW_YEAR.items(), key=lambda kv: -len(kv[0])) if short.startswith(k)), 2026)
        order += 1
        new.append({
            "brand": "Samsung", "model": model, "series": series_of(model), "variant": row["variant"], "price": int(row["price_inr"]),
            "supportEndYear": year + NEW_SEC(model, year), "sort": order,
            "source": {"kind": "oem_public", "label": "samsung.com/in selling price", "url": row["source_url"], "observedAt": row["source_date"]},
        })

out = {"observedAt": OBSERVED, "tradeModels": list(models.values()), "repairBook": repair, "sampleRateCard": entries, "newDevices": new}
json.dump(out, open(OUT, "w"), indent=1)
print(f"models={len(models)} repair={len(repair)} sampleEntries={len(entries)} newDevices={len(new)}")
