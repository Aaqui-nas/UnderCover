# Undercover entre potes

Clone du jeu Undercover : plus de 800 paires de mots dans 20 catégories, plus tes propres mots.
C'est une web-app installable (PWA) : elle marche sur iPhone et Android et fonctionne hors-ligne une fois ouverte.

## Mise en ligne automatique (GitHub Pages + GitHub Actions)
Adresse du jeu : **https://aaqui-nas.github.io/UnderCover/**

À chaque `git push` sur `main`, le workflow `.github/workflows/deploy.yml` :
1. vérifie la syntaxe du JavaScript et la liste de mots (`scripts/check-words.js` : pas de doublon ni de paire invalide) ;
2. publie le site sur GitHub Pages ;
3. change la version du cache hors-ligne, pour que les téléphones récupèrent la mise à jour.

Suivi des déploiements : onglet **Actions** du dépôt.

Mise en place (une seule fois) :
1. Dépôt : https://github.com/Aaqui-nas/UnderCover (doit être **public** pour GitHub Pages gratuit).
2. Dépôt → Settings → Pages → *Source* : **GitHub Actions**.
3. `git push -u origin main`

## Mots partagés entre tous les joueurs (Firebase, gratuit)
Sans cette étape, l'appli marche, mais les mots ajoutés restent sur chaque téléphone.

1. Va sur https://console.firebase.google.com → **Créer un projet** (ex. `undercover`). Tu peux désactiver Google Analytics.
2. **Authentication** → Commencer → onglet *Mode de connexion* → **Anonyme** → Activer → Enregistrer.
3. **Authentication** → onglet *Paramètres* → **Domaines autorisés** → Ajouter `aaqui-nas.github.io`.
4. **Firestore Database** → Créer une base de données → emplacement en Europe (ex. `eur3`) → **mode production**.
5. Firestore → onglet **Règles** → remplace tout par le contenu de `firestore.rules` → **Publier**.
6. ⚙️ **Paramètres du projet** → *Vos applications* → icône **Web `</>`** → donne un nom → Enregistrer.
   Copie l'objet `firebaseConfig` affiché et colle-le dans `firebase-config.js` à la place de `null` :
   `window.FIREBASE_CONFIG = { apiKey: "...", authDomain: "...", ... };`
7. `git add . && git commit -m "Firebase" && git push` → déployé automatiquement.

Dans l'appli, « ✏️ Ajouter des mots » affiche alors « ☁️ Connecté ». Les paires ajoutées apparaissent chez tout le monde
dans la catégorie « Mots partagés ». Chacun ne peut supprimer que ses propres ajouts.
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
Les mots sont dans `words.js` : ajoute des paires `["Mot civil", "Mot undercover"]` où tu veux.
