#!/usr/bin/env python3
"""Retakes the README screenshots from a running demo (./scripts/demo.sh), light theme, into docs/img/.

    python3 scripts/screenshots.py            # demo on http://localhost:8080

It creates a little real activity in the demo (a chat, a task and one follow-up) so that the pages are not empty.
"""
import os, sys, time
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE", "http://localhost:8080")
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "img")
size = {"width": 1440, "height": 900}

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(channel="chrome")
    except Exception:
        browser = p.chromium.launch()
    ctx = browser.new_context(viewport=size, color_scheme="light", device_scale_factor=1)
    ctx.add_init_script("localStorage.setItem('atelier.tour.disabled','1'); localStorage.setItem('atelier-theme','light')")
    pg = ctx.new_page()
    expect.set_options(timeout=60000)

    def shot(name, full=False):
        pg.wait_for_timeout(700)
        pg.screenshot(path=f"{OUT}/{name}.jpg", type="jpeg", quality=82, full_page=full)
        print("→", name)

    pg.goto(f"{BASE}/login")
    pg.get_by_label("Adresse e-mail").fill("admin@localhost"); pg.get_by_label("Mot de passe").fill("demo")
    pg.get_by_role("button", name="Se connecter").click()
    pg.wait_for_url("**/o/*")
    org = pg.url.split("/o/")[1].split("/")[0]
    api = f"/api/orgs/{org}"

    projects = pg.request.get(BASE + f"{api}/projects").json()
    boulangerie = next(x for x in projects if x["slug"] == "boulangerie")
    pg.request.post(BASE + f"{api}/knowledge", data={"title": "Ton et couleurs du site", "content": "# Ton et couleurs\n\n- Ton chaleureux, on tutoie les clients.\n- Couleurs : crème et brun.\n", "projectId": None, "enabled": True, "pinned": True})

    # a task, then one follow-up
    made = pg.request.post(BASE + f"{api}/conversations", data={"mode": "task", "projectId": boulangerie["id"], "text": "Ajoute une page Contact avec l'adresse, le téléphone et les horaires d'ouverture."}).json()
    cid, tid = made["conversation"]["id"], made["taskId"]
    def wait_done():
        for _ in range(90):
            if pg.request.get(BASE + f"{api}/tasks/{tid}").json()["status"] == "done": return
            time.sleep(1)
        sys.exit("la tâche n'a pas fini")
    wait_done()
    pg.request.post(BASE + f"{api}/conversations/{cid}/messages", data={"text": "Ajoute aussi un lien vers la page Contact dans le menu."})
    time.sleep(1); wait_done()

    pg.goto(f"{BASE}/o/{org}"); pg.wait_for_timeout(2500); shot("app-overview", full=True)
    pg.goto(f"{BASE}/o/{org}/conversations/{cid}"); expect(pg.get_by_test_id("turn-2")).to_be_visible(); shot("app-task")

    pg.goto(f"{BASE}/o/{org}/conversations")
    pg.get_by_role("button", name="Nouvelle conversation").first.click()
    dlg = pg.get_by_role("dialog")
    dlg.get_by_label("Projet").select_option(label=boulangerie["name"])
    dlg.get_by_label("Première question (facultatif)").fill("Quel ton prendre pour la page Contact ? Montre un exemple de code.")
    dlg.get_by_role("button", name="Démarrer").click()
    expect(pg.get_by_role("button", name="Copier")).to_be_visible(); shot("app-chat")

    pg.goto(f"{BASE}/o/{org}/guide"); shot("app-guide", full=True)
    pg.goto(f"{BASE}/o/{org}/usage"); pg.wait_for_timeout(1500); shot("app-usage", full=True)
    pg.goto(f"{BASE}/o/{org}/audit"); pg.wait_for_timeout(1000); shot("app-audit")
    browser.close()
