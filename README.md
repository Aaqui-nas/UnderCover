# Undercover entre potes

Clone du jeu Undercover. Toutes les paires de mots sont dans une base Firebase partagée : chacun peut en ajouter
depuis l'appli, dans une catégorie existante ou nouvelle.
C'est une web-app installable (PWA) : elle marche sur iPhone et Android et fonctionne hors-ligne une fois ouverte.

## Mise en ligne automatique (GitHub Pages + GitHub Actions)
Adresse du jeu : **https://aaqui-nas.github.io/UnderCover/**

À chaque `git push` sur `main`, le workflow `.github/workflows/deploy.yml` :
1. vérifie la syntaxe du JavaScript ;
2. publie le site sur GitHub Pages ;
3. change la version du cache hors-ligne, pour que les téléphones récupèrent la mise à jour.

Suivi des déploiements : onglet **Actions** du dépôt.

Mise en place (une seule fois) :
1. Dépôt : https://github.com/Aaqui-nas/UnderCover (doit être **public** pour GitHub Pages gratuit).
2. Dépôt → Settings → Pages → *Source* : **GitHub Actions**.
3. `git push -u origin main`

## Base de mots (Firebase, gratuit)
Déjà configurée (projet `undercover-12e56`). Pour repartir de zéro sur un autre projet :

1. Va sur https://console.firebase.google.com → **Créer un projet** (ex. `undercover`). Tu peux désactiver Google Analytics.
2. **Authentication** → Commencer → onglet *Mode de connexion* → **Anonyme** → Activer → Enregistrer.
3. **Authentication** → onglet *Paramètres* → **Domaines autorisés** → Ajouter `aaqui-nas.github.io`.
4. **Firestore Database** → Créer une base de données → emplacement en Europe (ex. `eur3`) → **mode production**.
5. Firestore → onglet **Règles** → remplace tout par le contenu de `firestore.rules` → **Publier**.
6. **Paramètres du projet** (roue dentée) → *Vos applications* → icône **Web `</>`** → donne un nom → Enregistrer.
   Copie l'objet `firebaseConfig` affiché et colle-le dans `firebase-config.js` à la place de `null` :
   `window.FIREBASE_CONFIG = { apiKey: "...", authDomain: "...", ... };`
7. `git add . && git commit -m "Firebase" && git push` → déployé automatiquement.

Fonctionnement :
- Au lancement avec internet, l'appli télécharge toute la liste et la garde sur le téléphone ; sans internet elle joue
  avec la dernière liste téléchargée. Il faut donc internet au moins une fois, au tout premier lancement.
- « Gérer les paires » : toutes les paires de la base par catégorie, avec recherche. Chacun peut en ajouter
  (deux mots + une catégorie existante ou nouvelle) et en supprimer. Hors-ligne, une paire ajoutée est mise en
  attente, jouable tout de suite, et envoyée au prochain lancement avec internet ; la suppression demande internet.
- Les paires se gèrent aussi dans la console Firebase (Firestore → collection `pairs` ; champs `a`, `b`, `cat`).

## Chrono de discussion
Réglé sur l'accueil avant la partie : sans, 1, 2, 3 ou 5 minutes par tour. Il démarre à chaque tour (pause et relance
possibles), puis sonne et vibre à zéro. L'écran reste allumé pendant le décompte.
Sur iPhone : pas de vibration (non supportée par Safari), et pas de son si le téléphone est en mode silencieux.
La clé `apiKey` n'est pas secrète, c'est normal qu'elle soit publique : la protection vient des règles Firestore.

## Installer sur le téléphone
- **iPhone** : ouvrir le lien dans **Safari** → bouton Partager → « Sur l'écran d'accueil ».
- **Android** : ouvrir le lien dans Chrome → menu ⋮ → « Installer l'application ».

## Obtenir un vrai APK (Android, optionnel)
Une fois le site en ligne : https://www.pwabuilder.com → coller l'URL → Package → Android → télécharger.
Le `.apk` du zip s'installe directement (autoriser « sources inconnues »). Ça ne marche pas sur iPhone.

## Tester en local
`python3 -m http.server 8000` puis ouvrir http://localhost:8000

## Mettre à jour
Modifie, puis `git add . && git commit -m "..." && git push` : le déploiement se fait tout seul.
Les mots ne sont pas dans le code : ajoute-les depuis l'appli.
