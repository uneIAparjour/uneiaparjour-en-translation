# uneiaparjour-en-translation

Pipeline de traduction FR→EN pour [uneiaparjour.fr](https://www.uneiaparjour.fr) — un outil d'IA générative par jour, en français depuis février 2023. Ce dépôt documente aussi bien le code que ce qui a cassé en le construisant, dans un souci de retour d'expérience honnête plutôt que de vitrine.

## Le projet

~1289 fiches-outils traduites et publiées en anglais, sans environnement de staging, directement sur un site WordPress en production. Le choix assumé dès le départ : avancer par petits paliers avec des filets de sécurité (sauvegardes, permissions minimales, revue humaine graduée) plutôt qu'attendre un environnement de test qui n'existait pas.

**Statut actuel** : 1269/1289 fiches du dataset officiel traduites et publiées. Flux quotidien entièrement automatisé (traduction → publication → commit d'état, zéro déclenchement humain). Reste à traiter : les pages statiques du site (sélection, à propos, aide au choix...) et l'habillage visuel de la version anglaise — voir « Ce qui reste à faire » plus bas.

## Architecture

- **WordPress REST API** — lecture/écriture des articles, catégories, métadonnées SEO.
- **Un plugin WordPress maison** (`wordpress-plugin/translation-bridge/`) — comble ce que l'API REST ne fait pas nativement : liaison des traductions Polylang (`pll_set_post_language`, `pll_save_post_translations`), exposition des champs SEO Yoast en lecture/écriture, hash de contenu stable pour la détection de changement.
- **Azure Translator** (offre S1, payante à l'usage) — moteur de traduction, avec un glossaire maison (`config/glossary.json`) pour protéger les noms de marques/outils IA qui se traduisent mal en isolation ("Reve" → "Dream", "T3 Chat" → "T3 Cat", etc.).
- **GitHub Actions** — orchestration quotidienne (cron 06:00 UTC), état persisté dans `script/state/translations.json`.

Choisi plutôt qu'un plugin clé-en-main (TranslatePress, Weglot) après comparaison : besoin de contrôle fin sur le glossaire, le anti-fig contenu Gutenberg, et les liens internes FR↔EN — un besoin que les plugins génériques ne couvrent pas bien pour ~1300 fiches courtes et très structurées.

## Cadre de sécurité

Aucun environnement de test n'étant disponible côté hébergeur, tout le filet de sécurité repose sur :
- Un utilisateur WordPress dédié à droits minimaux (rôle Author, jamais le compte admin personnel).
- Chaque endpoint du plugin gated par `current_user_can()` — jamais ouvert.
- Sauvegardes avant toute opération à risque.
- Test préalable du plugin dans WordPress Playground (bac à sable navigateur) avant tout déploiement réel.
- Détection de changement par hash de contenu (pas par date de modification) + un flag de verrouillage empêchant qu'un article EN corrigé à la main soit écrasé par un resync automatique.
- Dégradation gracieuse : un lien interne vers un article pas encore traduit reste sur la version FR plutôt que de casser.
- Montée en charge graduelle : quelques articles test → panel de revue manuelle (~50, puis ~150) → publication automatique seulement une fois la fiabilité prouvée à l'échelle.

## Journal des incidents

Construire ce pipeline sur un site en production, sans staging, a produit une vingtaine d'incidents réels. Les plus instructifs, avec la structure symptôme → diagnostic → cause racine → correctif → leçon :

### Tout le contenu FR était étiqueté "anglais" par Polylang
**Symptôme** : avant même le premier test réel, l'écran des langues Polylang montrait l'anglais comme langue par défaut, avec les 1319 articles français existants tagués "en".
**Cause racine** : mauvaise configuration d'origine, invisible sur un site mono-langue (peu importe l'étiquette interne quand il n'y a qu'une langue).
**Correctif** : ajout du français comme langue avec un endpoint dédié (`/set-language`) et un script de bascule en masse (1319 succès, 0 échec) — plutôt que de supprimer l'anglais, ce qui aurait fait disparaître tous les articles du site le temps de les réassigner.
**Leçon** : ne jamais supprimer une langue Polylang tant que du contenu réel y est encore rattaché.

### La date de publication FR était écrasée par la date de traduction
**Symptôme** : après activation de la synchronisation de dates Polylang, plusieurs articles FR anciens (MindDory, Vunote...) affichaient soudain la date du jour de traduction.
**Cause racine** : la synchronisation Polylang allait dans le sens inverse de celui attendu — créer la traduction EN écrasait la date de l'original FR, pas l'inverse.
**Correctif** : synchronisation Polylang désactivée, date copiée explicitement une seule fois (FR → EN, jamais l'inverse) à la création de chaque article EN.
**Leçon** : ne jamais présumer du sens d'une synchronisation automatique sans le vérifier dans un contexte sans conséquence.

### La détection de changement se déclenchait à chaque exécution, même sans changement réel
**Symptôme** : des articles déjà traduits réapparaissaient comme "à traduire" à chaque run.
**Cause racine** : le hash de contenu était calculé sur `content.rendered` — lequel change à chaque requête à cause d'identifiants aléatoires injectés par la fonctionnalité "lightbox" de WordPress, indépendamment de tout vrai changement de contenu.
**Correctif** : ajout d'un champ `raw_content` (contenu brut, stable) exposé par le plugin, utilisé uniquement pour le hash — la traduction elle-même continue d'utiliser le rendu.
**Leçon** : le HTML rendu par WordPress n'est jamais stable d'une requête à l'autre ; toujours hasher la source brute.

### Les blocs image/galerie se reconstruisaient mal — la vraie histoire en 5 correctifs
**Symptôme** : "contenu invalide" sur de nombreux articles EN contenant des images ou galeries ; les galeries ne s'affichaient jamais en colonnes.
**Cause racine, découverte après plusieurs correctifs qui traitaient le symptôme plutôt que la cause** : le pipeline reconstruisait les blocs Gutenberg à partir du HTML *rendu* par WordPress — lequel intègre du balisage propre à l'affichage (bouton de zoom, wrapper interactif) qui n'a jamais existé dans le contenu source réel et n'était donc jamais valide à réinjecter tel quel.
**Correctif définitif** : au lieu de reconstruire, copier directement les blocs image/galerie/vidéo/audio depuis le contenu brut FR (jamais traduits de toute façon, URLs identiques dans les deux langues) — `fixMediaBlocksFromSource()`.
**Leçon** : quand une reconstruction à partir d'une représentation dérivée produit un nouveau cas particulier à chaque correctif, vérifier si la source structurée d'origine est atteignable directement plutôt que de continuer à corriger la version dérivée.

### La saga des catégories — trois incidents du même type, chacun révélant un angle mort différent de Polylang
**Symptôme** : des scripts de nettoyage de catégories (censés ne supprimer que des doublons vides) ont, à trois reprises, supprimé ou renommé des catégories réellement utilisées.
**Cause racine, différente à chaque round** : (1) le champ natif `count` de WordPress ne comptabilise que les articles *publiés* — tous les articles EN étant en brouillon, chaque catégorie EN semblait avoir 0 usage ; (2) une règle de correction automatique, sûre uniquement pour le nettoyage initial, continuait de s'appliquer et re-cassait des catégories légitimes ; (3) Polylang filtre silencieusement toute requête `WP_Query`, même dans un plugin, à la langue "courante" — un filtre de comptage qui ne précisait pas `lang => ''` ne comptait donc jamais que les articles français.
**Correctif** : requêtes de comptage explicitement non filtrées par langue (`'lang' => ''`), suppression pure et simple de la règle de correction automatique une fois le nettoyage initial terminé (pas seulement désactivée — jugée dangereuse à réactiver un jour), erreurs de scripts de migration isolées post-par-post.
**Leçon** : sous Polylang, aucune requête de comptage n'est fiable par défaut — vérifier explicitement l'hypothèse de filtrage de langue à chaque script qui interroge le contenu en masse.

### Le quota gratuit Azure a été épuisé bien plus vite que prévu
**Symptôme** : toutes les traductions ont commencé à échouer avec une erreur d'authentification générique, pendant plus de 10 heures.
**Cause racine** : le quota gratuit (2M caractères/mois) a été consommé en moins de 3 jours réels — l'estimation initiale ("~1M caractères pour tout le backlog, tient sur le quota gratuit indéfiniment") n'avait pas anticipé le coût des tentatives échouées répétées (chaque retry renvoie tout le payload) ni les articles atypiquement longs.
**Correctif** : passage à l'offre payante à l'usage (S1) — coût réel mesuré : environ 0,02€/article, soit ~25€ pour tout le backlog restant.
**Leçon** : une estimation de volume basée sur le contenu final ignore le coût des échecs et des reprises — prévoir large, et surveiller le coût réel après chaque run, pas seulement une fois au début.

### Un article neuf perdait systématiquement ses catégories anglaises
**Symptôme** : les articles nouvellement créés se retrouvaient avec des catégories françaises, alors même que le code résolvait correctement les identifiants de catégories anglaises.
**Cause racine** : un article WordPress fraîchement créé n'a pas encore de langue Polylang tant que l'appel de liaison de traduction n'a pas eu lieu — pendant cette fenêtre, Polylang traite silencieusement l'article comme étant dans la langue par défaut du site et substitue toute catégorie anglaise par son équivalent français.
**Correctif** : les catégories/tags ne sont plus envoyés à la création de l'article, mais dans un second appel, une fois la langue établie via la liaison de traduction.
**Leçon** : l'ordre des opérations compte — un état "pas encore de langue" peut invalider silencieusement des données pourtant correctes.

### Une limite de colonne MySQL a bloqué un article, sans solution côté script
**Symptôme** : un article particulièrement long (ResearchDeck, un rapport HTML interactif embarqué) se retrouvait tronqué exactement à 65024 caractères, balise `</html>` de fermeture absente.
**Cause racine** : ce nombre correspond à la limite du type de colonne MySQL `TEXT` (65535 octets) — une anomalie de schéma au niveau de la base de données, hors de portée d'un script utilisant uniquement l'API REST.
**Correctif** : aucun correctif automatisé possible ; l'article a été reconstruit à la main.
**Leçon** : certaines limites ne se corrigent pas depuis le pipeline — accepter de mettre un cas de côté plutôt que de s'acharner à le résoudre par du code.

### Le même bug de limite de cadence quotidienne, deux fois, à deux endroits différents
**Symptôme** : après avoir relevé la limite de traitement quotidien à 200 articles/jour, le pipeline continuait, sans erreur visible, à n'en traiter que 15.
**Cause racine, la même classe de bug deux fois** : le champ `default:` d'une entrée `workflow_dispatch` de GitHub Actions ne s'applique qu'à un déclenchement manuel — un déclenchement `schedule` (le cron quotidien) ne lit jamais cette valeur, mais une chaîne de repli codée en dur ailleurs dans le fichier, qu'il faut éditer séparément.
**Correctif** : édition de la chaîne de repli réelle, à chaque fois.
**Leçon** : dans un fichier de workflow GitHub Actions avec `default:` + repli runtime, les deux valeurs doivent être maintenues en parallèle — un changement de l'une sans l'autre est un piège classique et silencieux.

### Un run interrompu a laissé 27 brouillons "fantômes", invisibles au suivi
**Symptôme** : le rapport de couverture ne mentionnait ni ces 27 articles ni aucune erreur les concernant, alors qu'ils existaient bel et bien sur le site en brouillon.
**Cause racine** : un run avait créé les 27 articles WordPress avec succès mais avait été interrompu avant l'étape finale d'enregistrement de l'état — aucune trace dans `state/translations.json`, donc invisibles à tout script qui se fie à ce fichier.
**Correctif** : script de diagnostic dédié comparant directement les brouillons WordPress à l'état enregistré, puis script de réparation appariant chaque orphelin à sa source FR par date exacte de publication.
**Leçon** : un fichier d'état n'est fiable que si sa mise à jour est atomique avec l'opération qu'il décrit — un run interrompu peut laisser une trace réelle mais non comptabilisée.

### La même faille a permis six doublons publiés, cette fois sur du contenu déjà en ligne
**Symptôme** : six articles anglais existaient chacun en double sur le site public, avec deux URLs distinctes pour un même article.
**Cause racine** : ces six articles avaient été créés par le même run interrompu que l'incident précédent — mais déjà publiés au moment du diagnostic initial, qui ne scannait que les brouillons. Le cron suivant les a donc retraduits comme s'ils n'avaient jamais été traités.
**Correctif** : élargissement du scan de diagnostic aux articles publiés (pas seulement en brouillon), dépublication ciblée du doublon le plus récent pour chacun des six cas.
**Leçon** : un correctif de diagnostic doit couvrir tous les états possibles d'un même bug, pas seulement celui observé en premier.

## Leçons transversales

- **Copier une source structurée intacte bat systématiquement la reconstruire depuis une version dérivée** — vrai pour le contenu média, probablement vrai ailleurs.
- **Sous Polylang, aucun comptage natif de WordPress n'est fiable sans vérification explicite du filtrage de langue.**
- **Un fichier d'état n'est correct que si son écriture est atomique avec l'action qu'il décrit** — sinon, un run interrompu laisse une trace réelle mais invisible.
- **Un correctif "safe une fois" peut devenir dangereux à la prochaine exécution** si les hypothèses sous-jacentes ont changé (ex. : la règle de migration de catégories, sûre pour le nettoyage initial, redevenue dangereuse une fois ce nettoyage terminé).
- **La revue manuelle graduée n'est pas de la prudence excessive** — plusieurs de ces incidents n'ont été détectés que parce qu'un humain regardait vraiment chaque article, pas seulement les logs de succès du script.

## Ce qui reste à faire

- Pages statiques du site (sélection, à propos, aide au choix, lettre d'infos...) — analysé, pas encore implémenté (voir les issues/discussions du dépôt pour le détail du blocage technique).
- Sélecteur de langue FR/EN en page d'accueil.
- Mention indiquant qu'il s'agit d'une traduction automatique, avec invitation à signaler les erreurs restantes.
- Audit des secrets dans l'historique git avant passage en public (aucun secret n'est committé directement — tout passe par les secrets GitHub Actions — mais à vérifier plutôt qu'à supposer).

## Structure du dépôt

- `wordpress-plugin/translation-bridge/` — le plugin WordPress maison (liaison Polylang + champs SEO Yoast + hash stable). `translation-bridge.zip` prêt à téléverser depuis wp-admin.
- `script/` — le pipeline Node.js (voir `script/README.md` pour le détail des fichiers et de l'utilisation).
- `plan/chantier-en.html` — copie locale du plan de travail complet.
- `.github/workflows/` — orchestration GitHub Actions (traduction quotidienne, publication, scripts de diagnostic/réparation ponctuels).
