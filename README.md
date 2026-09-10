# uneiaparjour-en-translation

Pipeline de traduction FR→EN pour [uneiaparjour.fr](https://www.uneiaparjour.fr) en français depuis février 2023. Ce dépôt documente aussi bien le code que ce qui a cassé en le construisant, dans un souci de retour d'expérience honnête plutôt que de vitrine.

## Le projet

~1300 articles traduits et publiés en anglais, directement sur le site WordPress réel : il n'existait pas de copie du site pour s'entraîner d'abord sans risque (environnement de « staging »), l'hébergeur ne proposant pas cette option. Plutôt que de chercher une solution de contournement, le choix assumé a été d'avancer par petits paliers avec des filets de sécurité (sauvegardes, permissions minimales, revue humaine graduée).

**Choix budgétaire assumé dès le départ** : rester gratuit, ou au pire au coût le plus bas possible, a été un critère de décision à chaque étape (moteur de traduction, hébergement des scripts, outils utilisés), pas un ajustement fait après coup. Concrètement : GitHub Actions (gratuit pour un dépôt de cette taille), Polylang extension Wordpress en version gratuite, et un moteur de traduction choisi en partie pour son offre gratuite généreuse (voir plus bas). Le seul poste réellement payant du projet, la traduction Azure, a coûté 11,27€ au total sur l'ensemble du projet, entièrement couvert par le crédit d'essai gratuit de 200$ offert à la création du compte Azure, donc 0€ à ce jour.

**Statut en fin de projet** : 1300/1300 fiches du dataset officiel traduites et publiées, couverture complète. Flux quotidien désormais entièrement automatisé (traduction → publication → commit d'état, zéro déclenchement humain). La vérification humaine, elle, est passée d'un contrôle après chaque publication à un contrôle hebdomadaire, la confiance dans la qualité de traduction, construite au fil des incidents documentés ci-dessous et de leurs correctifs, ne justifie plus un contrôle quotidien systématique.

## Architecture

- **[Polylang](https://wordpress.org/plugins/polylang/)** (version gratuite) — le plugin WordPress qui gère le site multilingue lui-même : bascule FR/EN, structure d'URL (`/en/...`), liaison entre un article français et sa traduction. C'est la brique qui fait tourner le site bilingue au quotidien ; le reste de ce dépôt existe pour la nourrir en contenu traduit. Sa version gratuite ne propose pas d'API pour lier une traduction depuis l'extérieur (seule la version payante Polylang Pro le permet) — c'est ce manque précis que le plugin maison ci-dessous comble.
- **WordPress REST API** — lecture/écriture des articles, catégories, métadonnées SEO.
- **Un plugin WordPress maison** (`wordpress-plugin/translation-bridge/`) — comble ce que l'API REST et Polylang gratuit ne font pas nativement : liaison des traductions (`pll_set_post_language`, `pll_save_post_translations`), exposition des champs SEO Yoast en lecture/écriture, hash de contenu stable pour la détection de changement.
- **Azure Translator** — moteur de traduction retenu après comparaison avec DeepL et Google (détail ci-dessous), avec un glossaire maison (`config/glossary.json`) pour protéger les noms de marques/outils IA qui se traduisent mal isolés dans le titre ("Reve" → "Dream", "T3 Chat" → "T3 Cat", etc.).
- **GitHub Actions** — orchestration quotidienne (cron 06:00 UTC), état persisté dans `script/state/translations.json`.
- **[Le dataset officiel des outils](https://huggingface.co/datasets/uneIAparjour/base)** hébergé sur Hugging Face et **[repo Github](https://github.com/uneIAparjour/base)**, la base de données du site : la liste exacte et à jour des 1300 fiches-outils réellement publiées, mise à jour automatiquement chaque nuit à partir du flux du site. C'est la référence que le pipeline consulte pour savoir quoi traduire : le site WordPress contient aussi d'autres contenus (newsletter, focus, lectures partagées) qui ne sont pas des articles d'applications et ne doivent pas être traduits comme si c'en était — sans ce filtre, le pipeline aurait traduit une quarantaine d'articles hors sujet. Le sens inverse est également protégé : la mise à jour automatique de ce dataset ignore explicitement toute URL en `/en/` — les articles traduits en anglais ne remontent jamais dans cette base, qui reste uniquement le reflet du contenu français original. [La base des articles en anglais](https://github.com/uneIAparjour/base-en) a été créée pour trace et documentation.

Choisi plutôt qu'un plugin clé-en-main (TranslatePress, Weglot) après comparaison : besoin de contrôle fin sur le glossaire, le contenu Gutenberg, et les liens internes FR↔EN — un besoin que les plugins génériques ne couvrent pas bien pour 1300 articles courts et très structurés.

### Le choix du moteur de traduction

Trois moteurs testés sur 25 extraits réels du site avant de choisir : **DeepL**, **Google Translate** et **Azure Translator**. Résultat : DeepL avait un léger avantage de fluidité, mais inconstant d'un extrait à l'autre, pas assez net pour trancher seul. Google, en revanche, a produit 7 erreurs franches sur les 25 extraits : exemple, le nom du modèle d'IA "Claude" traduit en "Claudius". **Azure Translator a été retenu** : qualité comparable aux deux autres sur cet échantillon, et surtout une offre gratuite généreuse (2 millions de caractères par mois, renouvelée indéfiniment) qui couvrait largement les besoins du projet. L'idée de mélanger deux moteurs (DeepL pour le gros du travail initial, Azure pour le flux quotidien) a été envisagée puis écartée : le gain de qualité ne valait pas le risque d'un style qui varie selon le moteur utilisé, pour un site qui doit sonner cohérent d'un article à l'autre.

## Cadre de sécurité

Faute d'un environnement de test séparé (le « staging » évoqué plus haut, une copie du site où essayer sans risque avant d'agir sur le site originel), tout le filet de sécurité repose sur :
- Un utilisateur WordPress dédié à droits minimaux (rôle Author, jamais le compte admin personnel). Même en cas de bug, ce compte ne peut techniquement pas toucher aux réglages du site ni aux 1300 articles français existants.
- Chaque fonction ajoutée par le plugin maison vérifie que celui qui l'appelle a bien les droits nécessaires avant d'agir (`current_user_can()`), aucune n'est accessible librement depuis l'extérieur sans authentification.
- Sauvegardes complète avant toute opération à risque.
- Test préalable du plugin dans [WordPress Playground](https://playground.wordpress.org/) (une version de WordPress qui tourne entièrement dans le navigateur, sans rien installer, permettant d'essayer le plugin sur un site jetable avant de le déployer réellement) avant tout déploiement réel.
- Détection de changement par hash de contenu (une empreinte numérique du texte, qui permet de savoir si un article a réellement changé sans se fier à sa date de modification, peu fiable) + un flag de verrouillage empêchant qu'un article EN corrigé à la main soit écrasé par un resync automatique.
- Si un article renvoie vers un autre article pas encore traduit, le lien reste vers la version française plutôt que de pointer vers une page qui n'existe pas encore, jamais de lien cassé, même quand la traduction est encore incomplète.
- Montée en charge graduelle par revue et publication manuelles systématiques : quelques articles test → plusieurs fois ~10, plusieurs fois ~50, puis ~150 → publication automatique seulement une fois la fiabilité prouvée à l'échelle.

## Journal des incidents

Construire ce pipeline sur un site en production, sans staging, a produit une vingtaine d'incidents réels. Les plus instructifs, avec la structure symptôme → diagnostic → cause racine → correctif → leçon :

### Tout le contenu FR était étiqueté "anglais" par Polylang
**Symptôme** : avant même le premier test réel, l'écran des langues Polylang montrait l'anglais comme langue par défaut, avec les 1319 articles français existants alors tagués "en".
**Cause racine** : mauvaise configuration d'origine, invisible sur un site mono-langue (peu importe l'étiquette interne quand il n'y a qu'une langue).
**Correctif** : ajout du français comme langue avec un endpoint dédié (`/set-language`) et un script de bascule en masse (1319 succès, 0 échec) plutôt que de supprimer l'anglais, ce qui aurait fait disparaître tous les articles du site le temps de les réassigner.
**Leçon** : ne jamais supprimer une langue Polylang tant que du contenu réel y est encore rattaché.

### La date de publication FR était écrasée par la date de traduction
**Symptôme** : après activation de la synchronisation de dates Polylang, plusieurs articles FR anciens (MindDory, Vunote...) affichaient soudain la date du jour de traduction.
**Cause racine** : la synchronisation Polylang allait dans le sens inverse de celui attendu, créer la traduction EN écrasait la date de l'original FR, pas l'inverse.
**Correctif** : synchronisation Polylang désactivée, date copiée explicitement une seule fois (FR → EN, jamais l'inverse) à la création de chaque article EN.
**Leçon** : ne jamais présumer du sens d'une synchronisation automatique sans le vérifier dans un contexte sans conséquence.

### La détection de changement se déclenchait à chaque exécution, même sans changement réel
**Symptôme** : des articles déjà traduits réapparaissaient comme "à traduire" à chaque run.
**Cause racine** : le hash de contenu était calculé sur `content.rendered`, lequel change à chaque requête à cause d'identifiants aléatoires injectés par la fonctionnalité "lightbox" de WordPress, indépendamment de tout vrai changement de contenu.
**Correctif** : ajout d'un champ `raw_content` (contenu brut, stable) exposé par le plugin, utilisé uniquement pour le hash, la traduction elle-même continue d'utiliser le rendu.
**Leçon** : le HTML rendu par WordPress n'est jamais stable d'une requête à l'autre ; toujours hasher la source brute.

### Les blocs image/galerie se reconstruisaient mal, 5 correctifs
**Symptôme** : "contenu invalide" sur de nombreux articles EN contenant des images ou galeries ; les galeries ne s'affichaient jamais en colonnes.
**Cause racine, découverte après plusieurs correctifs qui traitaient le symptôme plutôt que la cause** : le pipeline reconstruisait les blocs Gutenberg à partir du HTML *rendu* par WordPress, lequel intègre du balisage propre à l'affichage (bouton de zoom, wrapper interactif) qui n'a jamais existé dans le contenu source réel et n'était donc jamais valide à réinjecter tel quel.
**Correctif définitif** : au lieu de reconstruire, copier directement les blocs image/galerie/vidéo/audio depuis le contenu brut FR (jamais traduits de toute façon, URLs identiques dans les deux langues) — `fixMediaBlocksFromSource()`.
**Leçon** : quand une reconstruction à partir d'une représentation dérivée produit un nouveau cas particulier à chaque correctif, vérifier si la source structurée d'origine est atteignable directement plutôt que de continuer à corriger la version dérivée.

### La saga des catégories, trois incidents du même type, chacun révélant un angle mort différent de Polylang
**Symptôme** : des scripts de nettoyage de catégories (censés ne supprimer que des doublons vides) ont, à trois reprises, supprimé ou renommé des catégories réellement utilisées.
**Cause racine, différente à chaque round** : (1) le champ natif `count` de WordPress ne comptabilise que les articles *publiés*, tous les articles EN étant en brouillon, chaque catégorie EN semblait avoir 0 usage ; (2) une règle de correction automatique, sûre uniquement pour le nettoyage initial, continuait de s'appliquer et re-cassait des catégories légitimes ; (3) Polylang filtre silencieusement toute requête `WP_Query`, même dans un plugin, à la langue "courante", un filtre de comptage qui ne précisait pas `lang => ''` ne comptait donc jamais que les articles français.
**Correctif** : requêtes de comptage explicitement non filtrées par langue (`'lang' => ''`), suppression pure et simple de la règle de correction automatique une fois le nettoyage initial terminé (pas seulement désactivée, jugée dangereuse à réactiver un jour), erreurs de scripts de migration isolées post-par-post.
**Leçon** : sous Polylang, aucune requête de comptage n'est fiable par défaut, vérifier explicitement l'hypothèse de filtrage de langue à chaque script qui interroge le contenu en masse.

### Le quota gratuit Azure a été épuisé bien plus vite que prévu
**Symptôme** : toutes les traductions ont commencé à échouer avec une erreur d'authentification générique, pendant plus de 10 heures.
**Cause racine** : le quota gratuit (2M caractères/mois) a été consommé en moins de 3 jours réels, l'estimation initiale ("~1M caractères pour tout le backlog, tient sur le quota gratuit indéfiniment") n'avait pas anticipé le coût des tentatives échouées répétées (chaque retry renvoie tout le payload) ni les articles atypiquement longs.
**Correctif** : passage à l'offre Azure facturée à l'usage (S1), utilisée dans la limite du crédit d'essai gratuit de 200$ offert à la création du compte. Coût total réel sur l'ensemble du projet, vérifié une fois tout traduit : **11,27€**, intégralement pris en charge par ce crédit, 0€ engagés.
**Leçon** : une estimation de volume basée sur le contenu final ignore le coût des échecs et des reprises, prévoir large, et surveiller le coût réel après chaque run, pas seulement une fois au début.

### Un article neuf perdait systématiquement ses catégories anglaises
**Symptôme** : les articles nouvellement créés se retrouvaient avec des catégories françaises, alors même que le code résolvait correctement les identifiants de catégories anglaises.
**Cause racine** : un article WordPress fraîchement créé n'a pas encore de langue Polylang tant que l'appel de liaison de traduction n'a pas eu lieu. Pendant cette fenêtre, Polylang traite silencieusement l'article comme étant dans la langue par défaut du site et substitue toute catégorie anglaise par son équivalent français.
**Correctif** : les catégories/tags ne sont plus envoyés à la création de l'article, mais dans un second appel, une fois la langue établie via la liaison de traduction.
**Leçon** : l'ordre des opérations compte, un état "pas encore de langue" peut invalider silencieusement des données pourtant correctes.

### Une limite de colonne MySQL a bloqué un article, sans solution côté script
**Symptôme** : un article particulièrement long (ResearchDeck, un rapport HTML interactif embarqué) se retrouvait tronqué exactement à 65024 caractères, balise `</html>` de fermeture absente.
**Cause racine** : ce nombre correspond à la limite du type de colonne MySQL `TEXT` (65535 octets), une anomalie de schéma au niveau de la base de données, hors de portée d'un script utilisant uniquement l'API REST.
**Correctif** : aucun correctif automatisé possible ; l'article a été reconstruit à la main.
**Leçon** : certaines limites ne se corrigent pas depuis le pipeline, accepter de mettre un cas de côté plutôt que de s'acharner à le résoudre par du code.

### Le même bug de limite de cadence quotidienne, deux fois, à deux endroits différents
**Symptôme** : après avoir relevé la limite de traitement quotidien à 200 articles/jour, le pipeline continuait, sans erreur visible, à n'en traiter que 15.
**Cause racine, la même classe de bug deux fois** : le champ `default:` d'une entrée `workflow_dispatch` de GitHub Actions ne s'applique qu'à un déclenchement manuel, un déclenchement `schedule` (le cron quotidien) ne lit jamais cette valeur, mais une chaîne de repli codée en dur ailleurs dans le fichier, qu'il faut éditer séparément.
**Correctif** : édition de la chaîne de repli réelle, à chaque fois.
**Leçon** : dans un fichier de workflow GitHub Actions avec `default:` + repli runtime, les deux valeurs doivent être maintenues en parallèle — un changement de l'une sans l'autre est un piège classique et silencieux.

### Un run interrompu a laissé 27 brouillons "fantômes", invisibles au suivi
**Symptôme** : le rapport de couverture ne mentionnait ni ces 27 articles ni aucune erreur les concernant, alors qu'ils existaient bel et bien sur le site en brouillon.
**Cause racine** : un run avait créé les 27 articles WordPress avec succès mais avait été interrompu avant l'étape finale d'enregistrement de l'état. Aucune trace dans `state/translations.json`, donc invisibles à tout script qui se fie à ce fichier.
**Correctif** : script de diagnostic dédié comparant directement les brouillons WordPress à l'état enregistré, puis script de réparation appariant chaque orphelin à sa source FR par date exacte de publication.
**Leçon** : un fichier d'état n'est fiable que si sa mise à jour est liée avec l'opération qu'il décrit, un run interrompu peut laisser une trace réelle mais non comptabilisée.

### La même faille a permis six doublons publiés, cette fois sur du contenu déjà en ligne
**Symptôme** : six articles anglais existaient chacun en double sur le site public, avec deux URLs distinctes pour un même article.
**Cause racine** : ces six articles avaient été créés par le même run interrompu que l'incident précédent mais déjà publiés au moment du diagnostic initial, qui ne scannait que les brouillons. Le cron suivant les a donc retraduits comme s'ils n'avaient jamais été traités.
**Correctif** : élargissement du scan de diagnostic aux articles publiés (pas seulement en brouillon), dépublication ciblée du doublon le plus récent pour chacun des six cas.
**Leçon** : un correctif de diagnostic doit couvrir tous les états possibles d'un même bug, pas seulement celui observé en premier.

### Corriger un gap du dataset officiel a repris la traduction d'un article qu'on voulait explicitement laisser de côté
**Symptôme** : une comparaison FR/EN systématique du site a révélé deux fiches jamais traduites — "Reka" (article de 2024) et "Laper" (article de 2026) — absentes de `translations.json` sans jamais y être passées en erreur.
**Cause racine, différente pour chacune** : l'entrée dataset de Reka pointait vers une URL périmée (`/reka/`) après qu'un article plus récent, sans rapport, ait repris ce même slug. L'original avait été automatiquement renommé `/reka-1/` par WordPress, sans que le dataset ne soit mis à jour en conséquence. Laper, lui, n'avait tout simplement jamais été ajouté au dataset par le script de mise à jour nocturne du dépôt [`base`](https://github.com/uneIAparjour/base) (fondé sur le flux RSS du site, qui ne remonte pas indéfiniment en arrière).
**Correctif** : dataset officiel corrigé (URL de Reka réparée, Laper ajouté à sa date). Traduction demandée explicitement pour Laper seul, Reka devant rester de côté. Mais corriger l'entrée dataset de Reka l'a aussi rendu de nouveau éligible au flux **normal**, pas seulement au run manuel ciblé sur Laper : le cron quotidien suivant l'a traduit et publié tout seul, sans qu'aucune distinction ne soit possible entre "nouvel article à traiter" et "gap historique dont la correction ne devait pas déclencher de traduction".
**Leçon** : le pipeline ne fait aucune différence entre "jamais vu" et "volontairement mis de côté". Corriger une entrée du dataset source la remet toujours en file d'attente normale, jamais dans un traitement isolé, même quand l'intention au moment du correctif était différente.

**Effet de bord découvert dans la foulée** : le titre de l'article Laper a été traduit "Lap" au lieu de "Laper", Azure Translator a pris le nom de l'outil pour le verbe français "laper" et l'a traduit, alors que le contenu de l'article gardait correctement le nom intact. Ajouté à `config/glossary.json` pour éviter la récidive, mais la correction du titre déjà publié reste manuelle (aucun accès en écriture direct au site depuis l'endroit où le gap a été repéré).

## Leçons transversales

- **Copier une source structurée intacte bat systématiquement la reconstruction depuis une version dérivée**, vrai pour le contenu média, probablement vrai ailleurs.
- **Sous Polylang, aucun comptage natif de WordPress n'est fiable sans vérification explicite du filtrage de langue.**
- **Un fichier d'état n'est correct que si son écriture est liée avec l'action qu'il décrit**, sinon, un run interrompu laisse une trace réelle mais invisible.
- **Un correctif "safe une fois" peut devenir dangereux à la prochaine exécution** si les hypothèses sous-jacentes ont changé (ex. : la règle de migration de catégories, sûre pour le nettoyage initial, redevenue dangereuse une fois ce nettoyage terminé).
- **La revue manuelle graduée n'est pas de la prudence excessive** : plusieurs de ces incidents n'ont été détectés que parce que l'humain regardait vraiment chaque article, pas seulement les logs de succès du script.
- **Le pipeline ne distingue pas "jamais vu" de "mis de côté volontairement"** : toute correction du dataset source remet l'article correspondant dans le flux normal, sans exception possible depuis l'extérieur du code.

## Habillage du site EN

Traduire les articles ne suffit pas à faire un site bilingue : l'interface elle-même (menus, textes fixes, widgets) devait suivre. Ce travail touche le thème WordPress (Kenta) directement, pas le pipeline de traduction. Il partage la même contrainte : aucun de ces éléments n'est un texte enregistré comme traduisible par Polylang, donc rien de tout ça ne s'est fait automatiquement.

- **Menu latéral "Catégories" reconstruit pour l'anglais** — le menu déroulant regroupant les catégories par thème (Accès, Apprentissage, Audio, Images, Info & Recherche, Présentation, Texte & Documents, Web & Création, Archives) a été reconstruit à la main en anglais dans wp-admin, avec les bons liens vers les archives de catégories anglaises. Un bug trouvé au passage : un des groupes ("FR / EU") pointait vers l'archive française par erreur, deux termes de même nom existaient, l'un en anglais, l'un en français, et le mauvais avait été choisi ; corrigé en resélectionnant le bon terme.
- **Menus principaux et pied de page** : un menu minimal **"Under construction – More coming soon"** a d'abord servi de placeholder le temps que les pages statiques soient traduites une à une (voir la section suivante) ; le placement définitif des liens dans le menu restant à faire.
- **"Lire la suite" → "Read More"** — texte codé en dur dans le thème parent, introuvable dans les chaînes traduisibles de Polylang. Remplacé côté client par un petit script conditionnel (uniquement sur les pages anglaises).
- **Sous-titre du site** ("Une IA par jour, une lettre d'info par semaine" sous le logo) : même situation, texte codé en dur, corrigé par la même méthode côté serveur cette fois (le sous-titre est généré avant que la page n'arrive au navigateur).
- **Bloc newsletter (colonne latérale des articles)** : traduit avec la même technique, après une fausse piste, c'est un bloc HTML natif du constructeur de page, pas un widget classique WordPress, donc les filtres WordPress habituels ne s'y appliquaient pas.
- **Bloc "traduction automatique"** : ajouté au-dessus du bloc Contact sur les pages anglaises, pour prévenir les lecteurs que la traduction est automatique et les inviter à signaler une erreur.
- **Bouton de bascule FR ⇄ EN** : ajouté dans l'en-tête, à côté de la recherche et du bouton jour/nuit (icône globe, même style que les deux autres). Renvoie vers la traduction de la page en cours si elle existe, sinon vers l'accueil de l'autre langue, jamais vers un lien cassé.
- **Moteur de recherche** ([`recherche-outils`](https://github.com/uneIAparjour/recherche-outils)), cas différent des autres : l'interface elle-même se traduisait facilement, mais les résultats affichés venaient d'un fichier CSV entièrement en français. Plutôt qu'une traduction à la volée, un second dépôt ([`base-en`](https://github.com/uneIAparjour/base-en)) génère chaque nuit un CSV anglais équivalent, à partir des articles déjà traduits, le moteur de recherche choisit la bonne base selon la langue de la page.

**Une seule et même méthode derrière la plupart de ces cas** : le constructeur de page du thème (Kenta) ne propose aucune option native pour afficher un élément différemment selon la langue, et son éditeur ne permet pas d'ajouter un élément personnalisé à un endroit précis de l'en-tête. La solution retenue à chaque fois : un petit script, injecté uniquement sur les pages anglaises, qui repère l'élément concerné une fois la page chargée et le remplace ou complète plutôt que de chercher à modifier le constructeur lui-même. Le moteur de recherche fait exception : ses fichiers ne sont pas verrouillés dans un constructeur, la logique de langue a donc pu être ajoutée directement dans le code source plutôt que patchée après coup.

## Pages statiques et applications traduites

Au-delà du pipeline d'articles quotidiens, les pages fixes du site et les applications qui les accompagnent ont été traduites une à une, à la main, chacune a sa propre nature, aucun pipeline automatisé commun ne s'applique à ce groupe.

| Page FR | Page EN | Notes |
|---|---|---|
| [À propos](https://www.uneiaparjour.fr/a-propos/) | [About](https://www.uneiaparjour.fr/en/about/) | Inclut l'infographie de présentation, traduite séparément dans [`site-documentation`](https://github.com/uneIAparjour/site-documentation) |
| [Mentions et confidentialité](https://www.uneiaparjour.fr/mentions-legales-et-confidentialite/) | [Legal Notice & Privacy](https://www.uneiaparjour.fr/en/legal-notice-privacy/) | Références légales françaises (RGPD, LCEN...) traduites mais explicitement nommées, jamais localisées vers un autre droit |
| [Base du site](https://www.uneiaparjour.fr/base/) | [Site Database](https://www.uneiaparjour.fr/en/site-database/) | Liens réécrits vers le dépôt [`base-en`](https://github.com/uneIAparjour/base-en), pas une simple traduction du texte FR |
| [Contact](https://www.uneiaparjour.fr/contact/) | [Contact](https://www.uneiaparjour.fr/en/contact-2/) | Collision de slug avec l'original FR (limitation connue de Polylang sur ce site, acceptée partout où elle survient) |
| [Lettre](https://www.uneiaparjour.fr/lettre-dinfos/) | [Newsletter](https://www.uneiaparjour.fr/en/newsletter/) | L'embed Substack d'inscription reste en français (widget propre à Substack, hors de notre contrôle, une note sur la page en informe le lecteur) ; les lettres elles-mêmes sont traduites automatiquement par Substack pour les lecteurs anglophones |
| [Lectures partagées](https://www.uneiaparjour.fr/lectures-partagees/) | [Readings](https://www.uneiaparjour.fr/en/readings/) | Interface traduite ; les 390 ressources ont été traduites une fois, à la main (`data-en.json` dans [`export-lectures-partagees`](https://github.com/uneIAparjour/export-lectures-partagees)), mises à jour manuellement désormais, comme pour la version FR |
| Articles de la catégorie **Focus** (44 articles) | Catégorie EN « Focus » | Pipeline dédié séparé du reste (`translate-focus.js`/`publish-focus.js`), car ces articles sont hors du dataset outils base/base-en, voir la section suivante |
| [Sélection](https://www.uneiaparjour.fr/selection/) | [Selection](https://www.uneiaparjour.fr/en/selection-2/) | Le tableau et l'infographie Canva ont été remplacés par une page HTML/SVG autonome ([`uneiaparjour.github.io/selection/`](https://uneiaparjour.github.io/selection/selection-outils-en.html)) reprenant les vrais logos des outils |
| [Aide au choix](https://www.uneiaparjour.fr/aide/) | [Choosing a Tool](https://www.uneiaparjour.fr/en/choosing-a-tool/) | Pas une simple traduction : l'app ([`choix-outil-ia-en`](https://github.com/uneIAparjour/choix-outil-ia-en), dépôt séparé de l'original FR) ajoute un double filtre région (Europe/hors Europe, puis France/autre pays européen) pour n'exposer les critères RGPD/AI Act qu'aux lecteurs concernés, et généralise les critères propres à la France pour les autres |
| [Écho](https://www.uneiaparjour.fr/echo/) | [Echo](https://www.uneiaparjour.fr/en/echo-2/) | Décision éditoriale initialement d'abandonner la traduction (contenu narratif, ~300 fragments volontairement ambigus, proches de la poésie), puis reconsidérée. Traduit à la main plutôt que par le pipeline (registre littéraire, pas un article) et déployé sur un dépôt séparé ([`echo-en`](https://github.com/uneIAparjour/echo-en)) ; le document de conception et les notes de making-of ont aussi été traduits. L'accent sur "Écho" a été retiré pour la version anglaise ("Echo") |

Toutes les pages statiques du site ont désormais leur équivalent anglais.

Le placement de ces pages dans les menus EN (actuellement en placeholder, voir plus haut) a été réalisé, en bloc, une fois l'ensemble stabilisé, de même que deux liens manquants repérés dans le menu latéral "Catégories" EN (QR Code et Archives, catégories déjà traduites mais pas encore reliées dans le menu) et la traduction de l'étiquette du bouton hamburger ("Ouvrir le menu" → "Open menu", chaîne Polylang non renseignée).

## Le pipeline Focus (articles éditoriaux)

Les articles de la catégorie Focus (le billet de réflexion hebdomadaire lié à chaque lettre) partagent le type de contenu `post` avec les fiches outils, mais n'en sont pas : ce sont des essais personnels, pas des tests d'applications. Le pipeline principal (`translate.js`) les exclut explicitement de son périmètre via son filtre sur le dataset `base`. Un second pipeline, structurellement identique mais indépendant (`translate-focus.js` / `publish-focus.js`, état conservé dans `script/state/focus-translations.json`, jamais partagé avec `translations.json`), s'en charge séparément et tourne chaque nuit à 07h00 UTC — une heure après le pipeline principal. Les 44 articles existants ont été rattrapés en une fois ; les nouveaux sont pris en charge automatiquement.

## Structure du dépôt

- `wordpress-plugin/translation-bridge/` — le plugin WordPress maison (liaison Polylang + champs SEO Yoast + hash stable). `translation-bridge.zip` prêt à téléverser depuis wp-admin.
- `script/` — le pipeline Node.js (voir `script/README.md` pour le détail des fichiers et de l'utilisation).
- `.github/workflows/` — orchestration GitHub Actions (traduction quotidienne, publication, scripts de diagnostic/réparation ponctuels).
