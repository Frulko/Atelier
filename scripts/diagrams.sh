#!/usr/bin/env bash
# Regenerate docs/img/*.png and *.svg from docs/diagrams/*.html (diagram-design sources).
# Needs python3 + playwright and a Chrome/Chromium: pip install playwright
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import pathlib, re
from playwright.sync_api import sync_playwright

FONTS = ("<style>@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1"
         "&amp;family=Geist:wght@400;500;600&amp;family=Geist+Mono:wght@400;500;600&amp;display=swap');</style>")

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(channel="chrome")  # system Chrome, no download
    except Exception:
        browser = p.chromium.launch()
    page = browser.new_page(device_scale_factor=2)
    for src in sorted(pathlib.Path("docs/diagrams").glob("*.html")):
        out = pathlib.Path("docs/img") / src.stem
        page.goto(src.resolve().as_uri())
        page.wait_for_load_state("networkidle")
        page.evaluate("document.fonts.ready")
        page.locator("svg").first.screenshot(path=f"{out}.png")
        svg = re.search(r"<svg.*?</svg>", src.read_text(), re.S).group(0)
        if "xmlns=" not in svg.split(">")[0]:
            svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"', 1)
        svg = re.sub(r"(<svg[^>]*>\s*<title.*?</title>\s*<desc.*?</desc>)", r"\1<defs>" + FONTS.replace("\\", "\\\\") + "</defs>", svg, 1, re.S)
        out.with_suffix(".svg").write_text('<?xml version="1.0" encoding="UTF-8"?>\n' + svg)
        print(f"{out}.png, .svg")
    browser.close()
PY
