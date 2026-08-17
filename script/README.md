# Script de traduction FR → EN

Aucune dépendance npm — uniquement des modules Node natifs (`fetch`, `crypto`, `fs/promises`), donc pas de `npm install` à faire.

## Fichiers

- `translate.js` — point d'entrée
- `lib/wp.js` — client REST WordPress (auth Application Password)
- `lib/azure.js` — client Azure Translator (glossaire inclus via dynamic dictionary)
- `lib/content.js` — découpage en blocs + enveloppe Gutenberg + réécriture des liens internes
- `lib/taxonomy.js` — correspondance catégories/tags FR↔EN, créées à la volée et mises en cache
- `lib/state.js` — lecture/écriture de `state/translations.json`, hash du contenu source
- `config/glossary.json` — termes protégés (noms de marques/modèles IA) et traductions figées
- `config/taxonomy-map.json` — cache des correspondances catégories/tags (généré automatiquement)
- `state/translations.json` — suivi (ID FR, ID EN, hash, statut) — généré/mis à jour automatiquement

## Utilisation

Variables d'environnement requises (en local, ou déjà en secrets GitHub Actions) :
`WP_URL`, `WP_USERNAME`, `WP_APP_PASSWORD`, `AZURE_TRANSLATOR_KEY`, `AZURE_TRANSLATOR_REGION`

```bash
node translate.js --dry-run --limit=5   # aperçu, aucune écriture
node translate.js --limit=10            # traite jusqu'à 10 fiches
node translate.js --repair-links        # re-scanne les liens internes déjà traduits
```

Sans `--limit`, la valeur par défaut est 15.

## Ce qui est vérifié localement (sans réseau) vs pas encore testé en conditions réelles

Testé et validé : découpage HTML → blocs Gutenberg, réécriture des liens internes, application du glossaire, stabilité du hash.

**Pas encore testé en conditions réelles** (c'est l'objet de l'étape 04 du plan) : les vrais appels REST WordPress et Azure Translator, la création effective d'un article EN de bout en bout. Premier vrai test prévu sur 5-10 fiches réelles, en brouillon, avant tout passage à l'échelle.
