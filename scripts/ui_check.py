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

    def quiet(ctx):
        ctx.add_init_script("localStorage.setItem('atelier.tour.disabled', '1')")   # the welcome tour is tested on its own below
        return ctx
    admin = quiet(browser.new_context(viewport={"width": 1440, "height": 900})).new_page()
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
    nav(admin, "Conversations")                                                          # the task is also a conversation
    admin.get_by_role("link").filter(has_text=f"ajoute une note depuis l'interface {RUN}").click()
    expect(admin.get_by_test_id("turn-1")).to_be_visible()
    admin.get_by_label("Demander un ajustement").fill(f"ajoute aussi les horaires {RUN}")
    admin.get_by_label("Demander un ajustement").press("Enter")                          # a follow-up = a new agent turn, same branch
    expect(admin.get_by_text("Ajustement 1")).to_be_visible()
    expect(admin.get_by_text(re.compile("mise à jour")).first).to_be_visible(timeout=90000)
    expect(admin.get_by_role("link", name="Ouvrir dans l'éditeur")).to_be_visible()      # a finished task can be polished by hand
    shot(admin, "03b-task-conversation")
    admin.goto(first_task)
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
    side = admin.get_by_role("navigation", name="Menu du projet")                 # the project's own side menu
    crumbs = admin.get_by_role("navigation", name="Fil d'Ariane")                  # and the breadcrumb in the top bar
    expect(crumbs).to_contain_text("Projets"); expect(crumbs).to_contain_text("Todo API (Node)")
    for label, url in [("Tâches", "/tasks"), ("Conversations", "/conversations"), ("Connaissances", "/knowledge")]:
        side.get_by_role("link", name=re.compile(f"^{label}")).click()
        expect(admin).to_have_url(re.compile(f"projects/[0-9a-f]+{url}$"))
        expect(side).to_be_visible()                                                # the menu stays where we go
        expect(crumbs).to_contain_text(label)
    side.get_by_role("link", name=re.compile("^Conversations")).click()             # opening a conversation keeps the project context
    admin.get_by_role("main").get_by_role("link").filter(has_text="casse le projet").first.click()
    expect(admin).to_have_url(re.compile(r"projects/[0-9a-f]+/conversations/[0-9a-f]+$"))
    expect(side).to_be_visible(); expect(crumbs).to_contain_text("Conversation"); expect(crumbs).to_contain_text("Todo API (Node)")
    admin.get_by_role("link", name="Détail de la tâche").click()                     # and so does the task detail
    expect(admin).to_have_url(re.compile(r"projects/[0-9a-f]+/tasks/[0-9a-f]+$"))
    expect(side).to_be_visible(); expect(crumbs).to_contain_text("Tâche")
    side.get_by_role("link", name=re.compile("^Tâches")).click()
    admin.get_by_role("button", name="Nouveau", exact=True).first.click()           # one button, two modes: task or discussion
    dlg = admin.get_by_role("dialog")
    expect(dlg.get_by_role("radio", name="Discuter")).to_be_visible()
    expect(dlg.get_by_role("radio", name="Tâche")).to_be_visible()
    expect(dlg.get_by_label("Projet")).to_have_value(re.compile(".+"))          # the project is already chosen
    dlg.get_by_role("button", name="Annuler").click()
    side.get_by_role("link", name="Configuration").click()
    admin.get_by_role("button", name="Vérifier l'accès").click()
    expect(admin.get_by_text("Tout répond")).to_be_visible()                    # git ls-remote worked
    # ------------------------------------------------------------ the embedded editor (Monaco)
    side.get_by_role("link", name="Éditeur").click()
    tree = admin.get_by_role("list", name="Arbre des fichiers")
    expect(tree.get_by_text("server.js")).to_be_visible(timeout=60000)               # a private workspace was cloned
    expect(admin.get_by_text(re.compile("Tu édites une copie privée"))).to_be_visible()
    tree.get_by_text("server.js").click()
    expect(admin.get_by_role("tab", name=re.compile("server.js"))).to_be_visible()
    admin.locator(".monaco-editor").first.click()
    admin.keyboard.press("ControlOrMeta+End")
    admin.keyboard.type(f"\n// édité à la main {RUN}\n")
    expect(admin.get_by_text("Brouillon enregistré")).to_be_visible()                # autosaved draft
    expect(admin.get_by_role("list", name="Fichiers modifiés").get_by_text("server.js")).to_be_visible()
    expect(admin.get_by_label("Différences")).to_contain_text(f"édité à la main {RUN}")
    shot(admin, "05f-editor")
    admin.get_by_role("tab", name="Vérification").click()
    admin.get_by_role("button", name="Lancer la vérification").click()
    expect(admin.get_by_text("La vérification passe.")).to_be_visible(timeout=90000)   # the project check, in the sandbox
    admin.get_by_label("Valider les modifications").fill(f"Commentaire ajouté depuis l'éditeur {RUN}")
    admin.get_by_role("button", name="Valider et envoyer").click()
    expect(admin.get_by_test_id("commit-result")).to_contain_text("1 fichier envoyé", timeout=30000)
    admin.get_by_role("button", name=re.compile("Abandonner|Confirmer")).click()
    admin.get_by_role("button", name=re.compile("Abandonner|Confirmer")).click()      # two-click confirmation
    expect(admin.get_by_role("heading", level=1, name="Todo API (Node)")).to_be_visible()
    side.get_by_role("link", name="Configuration").click()
    admin.get_by_role("button", name="Modifier").click()                         # give the project a site address to watch
    dlg = admin.get_by_role("dialog")
    dlg.get_by_label("Adresse du site").fill("http://127.0.0.1:8080/healthz")   # seen from INSIDE the container
    dlg.get_by_role("button", name="Enregistrer").click()
    expect(admin.get_by_role("dialog")).to_have_count(0)
    nav(admin, "Vue d'ensemble")                                                 # dashboard: health, last commit, refresh
    card = admin.get_by_test_id("project-status-todo-api")
    expect(card.get_by_text(re.compile(r"[0-9a-f]{7}")).first).to_be_visible(timeout=30000)   # last commit, read from the repository
    card.get_by_role("button", name="Actualiser").click()
    expect(card.get_by_text(re.compile("En ligne"))).to_be_visible()
    shot(admin, "02b-dashboard-projects")
    nav(admin, "Projets")
    admin.get_by_role("button", name="Nouveau projet").click()
    dlg = admin.get_by_role("dialog")
    dlg.get_by_label("Nom affiché").fill(f"Projet UI {RUN}")
    expect(dlg.get_by_label("Identifiant")).to_have_value(f"projet-ui-{RUN}")             # the slug follows the name
    dlg.get_by_label("Dépôt git").fill("/fixtures/boulangerie.git")
    dlg.get_by_role("button", name="Créer le projet").click()
    expect(admin.get_by_role("heading", level=1, name=f"Projet UI {RUN}")).to_be_visible()
    admin.get_by_role("navigation", name="Menu du projet").get_by_role("link", name="Configuration").click()
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
    # ---------------------------------------------------------- conversations
    nav(admin, "Conversations")
    admin.get_by_role("button", name="Nouvelle conversation").first.click()
    dlg = admin.get_by_role("dialog")
    dlg.get_by_role("radio", name="Discuter").click()
    dlg.get_by_label("Première question (facultatif)").fill(f"Quel ton pour la page Contact {RUN} ?")
    dlg.get_by_role("button", name="Démarrer").click()
    expect(admin.get_by_text("Réponse factice").first).to_be_visible()                      # streamed by the fake model
    expect(admin.get_by_text(f"charte-{RUN}").first).to_be_visible()                        # shown as a source
    expect(admin.get_by_role("button", name="Copier")).to_be_visible()                      # the first answer is complete
    admin.get_by_label("Ton message").fill("Et pour les horaires ?")
    admin.get_by_label("Ton message").press("Enter")
    expect(admin.get_by_text("Et pour les horaires ?").first).to_be_visible()
    expect(admin.get_by_text("Réponse factice")).to_have_count(2)
    expect(admin.get_by_role("button", name="Copier")).to_be_visible()
    with tempfile.NamedTemporaryFile("w", suffix=".txt", prefix=f"horaires-{RUN}-", delete=False, encoding="utf-8") as f:
        f.write("Lundi-vendredi 7h-19h")
        horaires = f.name
    admin.locator('input[type="file"]').set_input_files(horaires)                            # attach a file
    expect(admin.get_by_text(f"horaires-{RUN}").first).to_be_visible()
    admin.get_by_label("Ton message").fill("Montre le code du lien")
    admin.get_by_label("Ton message").press("Enter")
    expect(admin.get_by_text("Réponse factice")).to_have_count(3)
    expect(admin.locator("pre").first).to_be_visible()                                       # the fenced code block is rendered
    expect(admin.get_by_text(f"horaires-{RUN}").first).to_be_visible()                      # the sent message keeps its chip
    os.unlink(horaires)
    shot(admin, "05c-conversation")
    nav(admin, "Conversations")
    expect(admin.get_by_text(f"Quel ton pour la page Contact {RUN}").first).to_be_visible()
    nav(admin, "Connaissances")
    item = admin.get_by_role("listitem").filter(has_text=f"charte-{RUN}")

    item.get_by_role("button", name="Désactiver").click()
    expect(item.get_by_text("Désactivée")).to_be_visible()
    admin.get_by_role("button", name="Tester").click()
    expect(admin.get_by_test_id("knowledge-preview")).to_contain_text("Rien")                  # disabled: not given any more
    rm_k = item.get_by_role("button", name=re.compile("Supprimer|Confirmer"))
    rm_k.click()
    rm_k.click()
    expect(admin.get_by_role("listitem").filter(has_text=f"charte-{RUN}")).to_have_count(0)
    os.unlink(charte)

    # ------------------------------------------------------------ guide, first steps and the welcome tour
    nav(admin, "Guide")
    expect(admin.get_by_role("heading", level=1, name="Guide")).to_be_visible()
    steps = admin.get_by_test_id("first-steps")
    expect(steps.locator("li[data-done='true']").filter(has_text="Lancer une tâche")).to_have_count(1)   # ticked from real data
    expect(steps.locator("li[data-done='true']").filter(has_text="Demander un ajustement")).to_have_count(1)
    expect(admin.get_by_text("Ce que l'agent peut faire, ou non")).to_be_visible()
    shot(admin, "05d-guide")
    steps.get_by_role("button", name="Ajouter « Ton et couleurs »").click()                # a step of the story prefills what to write
    dlg = admin.get_by_role("dialog")
    expect(dlg.get_by_label("Titre")).to_have_value("Ton et couleurs du site")
    expect(dlg.get_by_label("Contenu")).to_have_value(re.compile("Ton chaleureux"))
    dlg.get_by_role("button", name="Annuler").click()
    expect(admin.get_by_role("dialog")).to_have_count(0)
    nav(admin, "Guide")
    admin.get_by_role("button", name="Revoir la visite guidée").click()                    # replay the tour with the keyboard
    tour = admin.get_by_test_id("tour")
    expect(tour.get_by_role("dialog", name="Bienvenue dans Atelier")).to_be_visible()
    admin.keyboard.press("ArrowRight")
    expect(tour.get_by_role("dialog", name="Ton organisation")).to_be_visible()
    shot(admin, "05e-tour")
    admin.keyboard.press("ArrowLeft")
    expect(tour.get_by_role("dialog", name="Bienvenue dans Atelier")).to_be_visible()
    admin.keyboard.press("Escape")
    expect(tour).to_have_count(0)
    fresh = browser.new_context(viewport={"width": 1280, "height": 800}).new_page()       # NOT quiet: first sign-in shows the tour once
    fresh.on("console", lambda m: errors.append(f"console(tour): {m.text}") if m.type == "error" and "Failed to load resource" not in m.text else None)
    fresh.goto(f"{BASE}/login")
    sign_in(fresh, EMAIL, PASSWORD)
    expect(fresh.get_by_test_id("tour").get_by_role("dialog")).to_be_visible(timeout=15000)
    for _ in range(12):                                                                   # walk to the end: the last step opens the guide
        if fresh.get_by_role("button", name="Commencer les premiers pas").count(): break
        fresh.keyboard.press("ArrowRight")
    fresh.get_by_role("button", name="Commencer les premiers pas").click()
    fresh.wait_for_url("**/guide")
    expect(fresh.get_by_test_id("tour")).to_have_count(0)
    fresh.reload()
    fresh.wait_for_timeout(1500)
    expect(fresh.get_by_test_id("tour")).to_have_count(0)                                 # remembered: not shown again
    fresh.close()

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

    guest = quiet(browser.new_context(viewport={"width": 1280, "height": 800})).new_page()
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
    expect(admin.get_by_test_id("chat-usage")).to_contain_text("Réponses")                  # chat usage, in tokens
    expect(admin.get_by_test_id("chat-usage")).not_to_contain_text("0 Tokens lus")
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
    admin.get_by_label("Modèle", exact=True).fill("modele-de-test-1")                      # the assistant's model, per organization
    admin.get_by_role("button", name="Appliquer").click()
    expect(admin.get_by_text("Assistant enregistré.")).to_be_visible()
    admin.reload()
    expect(admin.get_by_label("Modèle", exact=True)).to_have_value("modele-de-test-1")
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
    phone = quiet(browser.new_context(viewport={"width": 390, "height": 800})).new_page()
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
