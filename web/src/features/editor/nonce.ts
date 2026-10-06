// Monaco crée lui-même des balises <style> : la page d'entrée porte un jeton (<meta name="csp-nonce">) que la CSP accepte pour les styles ;
// on le pose sur chaque <style> créé. Sans ce jeton (développement), rien ne change.
const nonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute("content");
if (nonce) {
  const create = document.createElement.bind(document) as (tag: string, options?: ElementCreationOptions) => HTMLElement;
  document.createElement = ((tag: string, options?: ElementCreationOptions) => { const el = create(tag, options); if (tag.toLowerCase() === "style") (el as HTMLStyleElement).nonce = nonce; return el; }) as typeof document.createElement;
}
