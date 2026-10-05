// Coût cantine : repas/jour × prix, avec tarif dégressif au-delà d'un seuil.
exports.cout = (repas, prix, seuil = Infinity, prixAuDela = prix) =>
  Math.min(repas, seuil) * prix + Math.max(0, repas - seuil) * prixAuDela;
