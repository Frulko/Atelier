/** « Mon Régie — v2 » → « mon-regie-v2 » : accents retirés, tout ce qui n'est pas lettre ou chiffre devient un tiret. */
export function slugify(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
}
