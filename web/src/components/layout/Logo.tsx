/**
 * Le logo : un « A » dessiné comme un petit graphe de commits — deux versions qui montent et se rejoignent au sommet, l'orange
 * marquant le point où elles se rencontrent (ce qu'on propose à la relecture). Tuile sombre comme le bouton principal, un seul accent.
 */
export function Logo({ className = "size-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <g fill="none" stroke="var(--primary-ink)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.5 23.5 16 8.5l6.5 15" />
        <path d="M12.4 18h7.2" />
      </g>
      <circle cx="9.5" cy="23.5" r="2.4" fill="var(--primary-ink)" />
      <circle cx="22.5" cy="23.5" r="2.4" fill="var(--primary-ink)" />
      <circle cx="16" cy="8.5" r="3.1" fill="var(--accent)" stroke="var(--primary)" strokeWidth="1.6" />
    </svg>
  );
}
