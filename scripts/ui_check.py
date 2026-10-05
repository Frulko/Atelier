#!/usr/bin/env python3
"""Drive the real web application in a browser (Playwright) and check every area works end to end.

Usage: ui_check.py BASE_URL EMAIL PASSWORD   (run by smoke.sh when Playwright is installed)
Needs: pip install playwright, and Chrome (or `playwright install chromium`).
Set UI_SHOTS=/some/dir to also save screenshots.

The backend must run with the fake agent and the demo projects (smoke.sh and demo.sh both do).
"""
import os
import re
import sys
import tempfile
import time

from playwright.sync_api import expect, sync_playwright

BASE, EMAIL, PASSWORD = sys.argv[1:4]
RUN = str(int(time.time()))[-6:]
INVITEE, INVITEE_PASSWORD = f"invitee-{RUN}@ui.test", "mdp-ui-12345"
SECRET_VALUE = f"sk-ant-ui-test-key-{RUN}"
SHOTS = os.environ.get("UI_SHOTS")
errors: list[str] = []


def shot(page, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=f"{SHOTS}/{name}.png", full_page=True)


def watch(page):
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    # a 401 on /api/me before sign-in is expected and logs a "Failed to load resource"
    page.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" and "Failed to load resource" not in m.text else None)


def nav(page, label):
    page.get_by_role("navigation", name="Navigation principale").get_by_role("link", name=label).click()


def sign_in(page, email, password):
    page.get_by_label("Adresse e-mail").fill(email)
    page.get_by_label("Mot de passe").fill(password)
    page.get_by_role("button", name="Se connecter").click()


with sync_playwright() as p:
    try:
        browser = p.chromium.launch(channel="chrome")  # system Chrome, no download
    except Exception:
        browser = p.chromium.launch()
    expect.set_options(timeout=20000)

    admin = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
    watch(admin)

    # ---------------------------------------------------------------- sign in
    resp = admin.goto(BASE)
    expect(admin).to_have_url(f"{BASE}/login")           # not signed in: sent to the login page
    csp = resp.headers.get("content-security-policy", "") if resp else ""
    assert "default-src 'self'" in csp and "frame-ancestors 'none'" in csp, f"CSP missing: {csp!r}"
    expect(admin.get_by_role("heading", name="Content de te revoir.")).to_be_visible()
    shot(admin, "01-login")
    sign_in(admin, EMAIL, "mauvais-mot-de-passe")
    expect(admin.get_by_role("alert")).to_contain_text("incorrect")
    sign_in(admin, EMAIL, PASSWORD)
    admin.wait_for_url("**/o/*")
    ORG = admin.url.split("/o/")[1].split("/")[0]
    OBASE = f"{BASE}/o/{ORG}"

    # --------------------------------------------------------------- overview
    expect(admin.get_by_role("heading", level=1)).to_be_visible()
    expect(admin.get_by_text("Taux de réussite")).to_be_visible()
    expect(admin.get_by_role("navigation", name="Navigation principale").get_by_role("link", name="Journal d'audit")).to_be_visible()
    shot(admin, "02-overview")

    # ------------------------------------------------------------ a task, end to end (fake agent)
    nav(admin, "Tâches")
    admin.get_by_role("button", name="Nouvelle tâche").first.click()
    dlg = admin.get_by_role("dialog")
    dlg.get_by_label("Projet").select_option(label="Mini Régie (calculs)")
    dlg.get_by_label("Ta demande").fill(f"ajoute une note depuis l'interface {RUN}")
    dlg.get_by_role("button", name="Lancer la tâche").click()
    admin.wait_for_url("**/tasks/*")
    expect(admin.get_by_text("Branche atelier/").first).to_be_visible(timeout=90000)   # the live journal reached "branch pushed"
    expect(admin.get_by_text("Prête à valider").first).to_be_visible()
    expect(admin.get_by_text("NOTES.md").first).to_be_visible()                         # files changed
    shot(admin, "03-task-detail")
    first_task = admin.url
    admin.get_by_role("button", name="Relancer").click()                                 # retry = a NEW task
    admin.wait_for_url(lambda u: "/tasks/" in u and u != first_task)

    nav(admin, "Tâches")                                                                 # filters live in the URL
    admin.get_by_role("button", name="Prête à valider").click()
    expect(admin).to_have_url(re.compile(r"status=done"))
    admin.get_by_label("Rechercher").fill(RUN)
    expect(admin).to_have_url(re.compile(rf"q=(%22)?{RUN}"))  # the router quotes numeric-looking text in the URL
    expect(admin.get_by_role("row").filter(has_text=RUN).first).to_be_visible()
    shot(admin, "04-tasks")
    admin.get_by_role("button", name="Réinitialiser les filtres").click()
    expect(admin).to_have_url(f"{OBASE}/tasks")

    # --------------------------------------------------------------- projects
    nav(admin, "Projets")
    expect(admin.get_by_role("heading", name="Todo API (Node)")).to_be_visible()
    shot(admin, "05-projects")
    admin.get_by_role("link").filter(has_text="Todo API (Node)").click()
    admin.get_by_role("button", name="Vérifier l'accès").click()
    expect(admin.get_by_text("Tout répond")).to_be_visible()                    # git ls-remote worked
    nav(admin, "Projets")
    admin.get_by_role("button", name="Nouveau projet").click()
    dlg = admin.get_by_role("dialog")
    dlg.get_by_label("Nom affiché").fill(f"Projet UI {RUN}")
    expect(dlg.get_by_label("Identifiant")).to_have_value(f"projet-ui-{RUN}")             # the slug follows the name
    dlg.get_by_label("Dépôt git").fill("/fixtures/boulangerie.git")
    dlg.get_by_role("button", name="Créer le projet").click()
    expect(admin.get_by_role("heading", level=1, name=f"Projet UI {RUN}")).to_be_visible()
    delete = admin.get_by_role("button", name=re.compile("Supprimer|Confirmer"))   # its label changes once armed
    delete.click()
    delete.click()                                                                        # two-click confirmation
    expect(admin.get_by_role("heading", name=f"Projet UI {RUN}")).to_have_count(0)

    # ----------------------------------------------------------- integrations
    nav(admin, "Intégrations")
    admin.get_by_role("button", name="Ajouter un secret").click()
    dlg = admin.get_by_role("dialog")
    dlg.get_by_label("Type").select_option("provider_key")
    dlg.get_by_label("Libellé").fill(f"ui-key-{RUN}")
    dlg.get_by_label("Valeur").fill(SECRET_VALUE)
    dlg.get_by_role("button", name="Enregistrer").click()
    expect(admin.get_by_text(f"ui-key-{RUN}").first).to_be_visible()
    expect(admin.get_by_text(SECRET_VALUE[-4:]).first).to_be_visible()                     # only the hint
    assert SECRET_VALUE not in admin.content(), "the secret value is visible in the page"
    shot(admin, "06-integrations")

    # -------------------------------------------------------------- knowledge
    nav(admin, "Connaissances")
    admin.get_by_role("button", name="Nouvelle connaissance").first.click()
    dlg = admin.get_by_role("dialog")
    with tempfile.NamedTemporaryFile("w", suffix=".md", prefix=f"charte-{RUN}-", delete=False, encoding="utf-8") as f:
        f.write("# Ton et couleurs\n\n- Ton chaleureux, tutoiement.\n- Couleurs : crème et brun.\n")
        charte = f.name
    dlg.get_by_label("Importer un fichier").set_input_files(charte)                       # import a markdown file
    expect(dlg.get_by_label("Titre")).to_have_value(re.compile(f"charte-{RUN}"))           # the title comes from the file name
    expect(dlg.get_by_label("Contenu")).to_have_value(re.compile("Ton chaleureux"))
    dlg.get_by_role("tab", name="Aperçu").click()
    expect(dlg.get_by_text("Ton et couleurs")).to_be_visible()                              # markdown preview
    dlg.get_by_role("button", name="Enregistrer").click()
    item = admin.get_by_role("listitem").filter(has_text=f"charte-{RUN}")
    expect(item).to_be_visible()
    admin.get_by_label("Une demande ou une question").fill("quelle charte pour la page Contact ?")
    admin.get_by_role("button", name="Tester").click()
    expect(admin.get_by_test_id("knowledge-preview")).to_contain_text("1 connaissance donnée")  # what the assistant would know
    shot(admin, "05b-knowledge")
    item.get_by_role("button", name="Désactiver").click()
    expect(item.get_by_text("Désactivée")).to_be_visible()
    admin.get_by_role("button", name="Tester").click()
    expect(admin.get_by_test_id("knowledge-preview")).to_contain_text("Rien")                  # disabled: not given any more
    rm_k = item.get_by_role("button", name=re.compile("Supprimer|Confirmer"))
    rm_k.click()
    rm_k.click()
    expect(admin.get_by_role("listitem").filter(has_text=f"charte-{RUN}")).to_have_count(0)
    os.unlink(charte)

    # ------------------------------------------------------------------- team
    nav(admin, "Équipe")
    admin.get_by_role("button", name="Inviter").first.click()
    dlg = admin.get_by_role("dialog")
    dlg.get_by_label("Adresse e-mail").fill(INVITEE)
    dlg.get_by_role("button", name="Créer le lien").click()
    link = dlg.get_by_label("Lien d'invitation").input_value()
    assert link.startswith(f"{BASE}/invite?token=inv_"), link
    dlg.get_by_role("button", name="Terminé").click()
    expect(admin.get_by_text(INVITEE)).to_be_visible()                                      # pending invitation listed

    guest = browser.new_context(viewport={"width": 1280, "height": 800}).new_page()
    watch(guest)
    guest.goto(link)
    expect(guest.get_by_role("heading", name="Tu es invité(e).")).to_be_visible()
    shot(guest, "07-invite")
    guest.get_by_label("Mot de passe").fill(INVITEE_PASSWORD)
    guest.get_by_role("button", name="Créer mon compte et rejoindre").click()
    guest.wait_for_url("**/o/*")
    nav_g = guest.get_by_role("navigation", name="Navigation principale")
    expect(nav_g.get_by_role("link", name="Tâches")).to_be_visible()
    expect(nav_g.get_by_role("link", name="Équipe")).to_have_count(0)                       # a member sees no admin area…
    expect(nav_g.get_by_role("link", name="Journal d'audit")).to_have_count(0)
    guest.goto(f"{OBASE}/audit")                                                              # …a hand-typed link goes back to the overview…
    expect(guest).to_have_url(OBASE)
    status = guest.evaluate(f"fetch('/api/orgs/{ORG}/audit').then(r => r.status)")           # …and the server refuses anyway
    assert status == 403, status
    guest.goto(link)                                                                          # the link works once
    guest.get_by_role("button", name="Rejoindre l'organisation").click()
    expect(guest.get_by_role("alert")).to_contain_text("invalide")

    admin.reload()
    row = admin.get_by_role("row").filter(has_text=INVITEE)
    expect(row).to_have_count(1)
    row.get_by_role("combobox").select_option("viewer")
    expect(admin.get_by_text("Rôle mis à jour.")).to_be_visible()
    row = admin.get_by_role("row").filter(has_text=INVITEE)
    expect(row.get_by_role("combobox")).to_have_value("viewer")
    shot(admin, "08-team")
    rm = row.locator("button").last
    rm.click()
    rm.click()                                                                                # two-click removal
    expect(admin.get_by_role("row").filter(has_text=INVITEE)).to_have_count(0)

    # ------------------------------------------------------------------ usage
    nav(admin, "Usage")
    expect(admin.get_by_text("Budget du mois en cours")).to_be_visible()
    admin.get_by_label("Plafond mensuel (en $)").fill("50")
    admin.get_by_role("button", name="Enregistrer").click()
    expect(admin.get_by_text("/ 50,00 $")).to_be_visible()
    shot(admin, "09-usage")
    admin.get_by_role("button", name="Supprimer le plafond").click()
    expect(admin.get_by_text("Aucun plafond")).to_be_visible()

    # ------------------------------------------------------------------ audit
    nav(admin, "Journal d'audit")
    expect(admin.get_by_text(f"a ajouté le secret « ui-key-{RUN} »")).to_be_visible()
    expect(admin.get_by_text(f"a invité {INVITEE}")).to_be_visible()
    admin.get_by_role("button", name="Secrets", exact=True).click()
    expect(admin).to_have_url(re.compile(r"action=secret\."))
    expect(admin.get_by_text(f"a invité {INVITEE}")).to_have_count(0)                         # the filter applies
    shot(admin, "10-audit")
    csv_href = admin.get_by_role("link").filter(has_text="Exporter en CSV").get_attribute("href")
    assert "format=csv" in csv_href
    csv = admin.request.get(BASE + csv_href)
    assert csv.status == 200 and "text/csv" in csv.headers["content-type"], csv.status
    assert "secret.create" in csv.text() and SECRET_VALUE not in csv.text(), "CSV export is wrong or leaks a secret"

    # ----------------------------------------------------------- organization
    nav(admin, "Organisation")
    name_box = admin.get_by_label("Nom de l'organisation")
    original = name_box.input_value()
    name_box.fill(f"{original} bis")
    admin.get_by_role("button", name="Enregistrer").click()
    expect(admin.get_by_text("Nom enregistré.")).to_be_visible()
    expect(admin.get_by_text(f"{original} bis").first).to_be_visible()
    name_box.fill(original)
    admin.get_by_role("button", name="Enregistrer").click()
    expect(admin.get_by_role("button", name="Enregistrer")).to_be_disabled()
    admin.get_by_role("button", name="Supprimer…").click()                                    # deleting needs the exact name
    expect(admin.get_by_role("button", name="Supprimer définitivement")).to_be_disabled()
    admin.get_by_role("dialog").get_by_role("button", name="Annuler").click()

    # ---------------------------------------------------------------- account
    admin.get_by_role("link").filter(has_text=EMAIL).first.click()
    expect(admin.get_by_role("heading", name="Mon compte")).to_be_visible()
    admin.get_by_label("Nom affiché").fill("Admin Test")
    admin.get_by_role("button", name="Enregistrer").click()
    expect(admin.get_by_text("Profil enregistré.")).to_be_visible()
    expect(admin.get_by_text("Admin Test").first).to_be_visible()
    expect(admin.get_by_text("Cet appareil")).to_be_visible()                                  # the sessions list shows this browser
    admin.get_by_role("tab", name="Sombre").click()
    expect(admin.locator("html")).to_have_attribute("data-theme", "dark")
    shot(admin, "11-account-dark")
    admin.get_by_role("tab", name="Système").click()
    expect(admin.locator("html")).not_to_have_attribute("data-theme", "dark")
    admin.get_by_label("Nom affiché").fill("")
    admin.get_by_role("button", name="Enregistrer").click()
    expect(admin.get_by_text("Profil enregistré.").first).to_be_visible()

    # ----------------------------------------------------------------- mobile
    phone = browser.new_context(viewport={"width": 390, "height": 800}).new_page()
    watch(phone)
    phone.goto(f"{BASE}/login")
    sign_in(phone, EMAIL, PASSWORD)
    phone.wait_for_url("**/o/*")
    expect(phone.get_by_role("navigation", name="Navigation principale")).to_be_hidden()      # closed by default on a phone
    phone.get_by_role("button", name="Ouvrir le menu").click()
    expect(phone.get_by_role("navigation", name="Navigation principale")).to_be_visible()
    phone.wait_for_timeout(600)                                                              # let the drawer finish sliding in
    shot(phone, "12-mobile-menu")
    phone.get_by_role("navigation", name="Navigation principale").get_by_role("link", name="Tâches").click()
    expect(phone.get_by_role("heading", level=1, name="Tâches")).to_be_visible()
    assert phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "horizontal scroll on a phone"

    # ----------------------------------------------------------------- sign out
    admin.get_by_role("button", name="Se déconnecter").click()
    expect(admin).to_have_url(f"{BASE}/login")
    admin.goto(f"{OBASE}/tasks")                                                               # signed out: a deep link asks to sign in
    expect(admin).to_have_url(re.compile(r"/login"))

    browser.close()

if errors:
    print("UI errors:\n" + "\n".join(errors))
    sys.exit(1)
print("UI OK")
