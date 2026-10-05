#!/usr/bin/env python3
"""Drive the real web UI in a browser (Playwright): login, task, settings, invitation, roles.

Usage: ui_check.py BASE_URL EMAIL PASSWORD   (run by smoke.sh when Playwright is installed)
Needs: pip install playwright, and Chrome (or `playwright install chromium`).
"""
import os
import sys
from playwright.sync_api import sync_playwright, expect

BASE, EMAIL, PASSWORD = sys.argv[1:4]
INVITEE, INVITEE_PASSWORD = "invitee@ui.test", "mdp-ui-12345"
SECRET_VALUE = "sk-ant-ui-test-key-0001"
errors = []
SHOTS = os.environ.get("UI_SHOTS")  # directory: also save screenshots (for a human to look at)


def shot(page, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=f"{SHOTS}/{name}.png", full_page=True)


def watch(page):
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    # a 401 on /api/me before login is expected and logs a "Failed to load resource"
    page.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" and "Failed to load resource" not in m.text else None)


with sync_playwright() as p:
    try:
        browser = p.chromium.launch(channel="chrome")  # system Chrome, no download
    except Exception:
        browser = p.chromium.launch()
    expect.set_options(timeout=15000)

    admin = browser.new_context().new_page()
    watch(admin)

    # --- login: wrong password, then the right one
    admin.goto(BASE)
    expect(admin.locator("#login")).to_be_visible()
    expect(admin.locator("#app")).to_be_hidden()      # only one screen at a time
    expect(admin.locator("#invite")).to_be_hidden()
    shot(admin, "1-login")
    admin.fill("#email", EMAIL); admin.fill("#pass", "mauvais-mot-de-passe"); admin.click("#lf button.primary")
    expect(admin.locator("#lerr")).to_contain_text("incorrect")
    admin.fill("#pass", PASSWORD); admin.click("#lf button.primary")
    expect(admin.locator("#app")).to_be_visible()
    expect(admin.locator("#login")).to_be_hidden()
    expect(admin.locator("#invite")).to_be_hidden()
    expect(admin.locator("#v-settings")).to_be_hidden()  # the tasks tab shows no settings
    expect(admin.locator("#who")).to_contain_text(EMAIL)

    # --- a task, end to end (fake agent): the log reaches "branch pushed", and the list shows the project NAME
    expect(admin.locator("#project option")).to_have_count(3)
    admin.select_option("#project", label="Mini Régie (calculs)")
    admin.fill("#prompt", "ajoute une note depuis l'interface"); admin.click("#f button.primary")
    expect(admin.locator("#log .e-done")).to_contain_text("Branche", timeout=90000)
    expect(admin.locator("#tasks")).to_contain_text("Mini Régie (calculs)")
    shot(admin, "2-tasks")

    # --- settings: a model key is stored and never shown again
    admin.click("#tab-settings")
    expect(admin.get_by_role("heading", name="Membres")).to_be_visible()
    expect(admin.locator("#v-tasks")).to_be_hidden()      # and the settings tab shows no tasks
    admin.select_option('form[data-form="secret"] [name=kind]', "provider_key")
    expect(admin.locator('form[data-form="secret"] [name=provider]')).to_be_visible()
    admin.fill('form[data-form="secret"] [name=label]', "ui-key")
    admin.fill('form[data-form="secret"] [name=value]', SECRET_VALUE)
    admin.click('form[data-form="secret"] button.primary')
    expect(admin.locator("#v-settings")).to_contain_text("ui-key")
    expect(admin.locator("#v-settings")).to_contain_text("…0001")
    assert SECRET_VALUE not in admin.content(), "the secret value is visible in the page"

    # --- invitation: the link is shown once; a stranger opens it and joins as a member
    admin.fill('form[data-form="invite"] [name=email]', INVITEE)
    admin.select_option('form[data-form="invite"] [name=role]', "member")
    admin.click('form[data-form="invite"] button.primary')
    link = admin.locator("#invlink").input_value()
    shot(admin, "3-settings")
    assert link.startswith(f"{BASE}/?invite=inv_"), link

    guest = browser.new_context().new_page()
    watch(guest)
    guest.goto(link)
    expect(guest.locator("#invite")).to_be_visible()
    expect(guest.locator("#login")).to_be_hidden()
    expect(guest.locator("#app")).to_be_hidden()
    shot(guest, "4-invite")
    guest.fill("#inpass", INVITEE_PASSWORD); guest.click("#inbtn")
    expect(guest.locator("#app")).to_be_visible()
    expect(guest.locator("#who")).to_contain_text(INVITEE)
    expect(guest.locator("#who")).to_contain_text("membre")
    expect(guest.locator("#tab-settings")).to_be_hidden()  # a member gets no settings
    assert "invite=" not in guest.url, "the invitation token stays in the address bar"
    guest.goto(link)  # the link is single-use; the guest is now signed in, so the page offers "join" without a password
    expect(guest.locator("#inpass")).to_be_hidden()
    guest.click("#inbtn")
    expect(guest.locator("#inerr")).to_contain_text("invalide")

    # --- roles: change the new member's role, then remove them (two-click confirmation)
    admin.click("#tab-tasks"); admin.click("#tab-settings")
    row = admin.locator("tr", has_text=INVITEE)
    expect(row).to_have_count(1)  # only the members table: the pending invitation was consumed
    # changing a role reloads the view; wait for that reload to finish so the next click is not wiped by it
    with admin.expect_response(lambda r: r.request.method == "GET" and r.url.endswith("/members")):
        row.locator("select").select_option("viewer")
    expect(admin.locator('#v-settings[data-ready="1"]')).to_be_visible()
    expect(admin.locator("tr", has_text=INVITEE).locator("select")).to_have_value("viewer")
    btn = admin.locator("tr", has_text=INVITEE).locator('button[data-act="rm-member"]')  # stable: its label changes when armed
    btn.click()
    expect(btn).to_have_text("Confirmer ?")
    btn.click()
    expect(admin.locator("tr", has_text=INVITEE)).to_have_count(0)

    # --- logout
    admin.click("#logout")
    expect(admin.locator("#login")).to_be_visible()

    browser.close()

if errors:
    print("UI errors:\n" + "\n".join(errors))
    sys.exit(1)
print("UI OK")
