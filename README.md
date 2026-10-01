# Undercover entre potes

Clone du jeu Undercover : plus de 800 paires de mots dans 21 catégories, plus tes propres mots.
C'est une web-app installable (PWA) : elle marche sur iPhone et Android et fonctionne hors-ligne une fois ouverte.

## Mettre en ligne (gratuit) — GitHub Pages
1. Crée un dépôt public sur github.com (ex. `undercover`).
2. Envoie ces fichiers dans le dépôt :
   ```
   git init && git add . && git commit -m "Undercover"
   git branch -M main
   git remote add origin https://github.com/<ton-pseudo>/undercover.git
   git push -u origin main
   ```
3. Sur GitHub : Settings → Pages → Branch `main` / `root` → Save.
4. Le jeu sera dispo sur `https://<ton-pseudo>.github.io/undercover/` → envoie ce lien à tes potes.

## Installer sur le téléphone
- **iPhone** : ouvrir le lien dans **Safari** → bouton Partager → « Sur l'écran d'accueil ».
- **Android** : ouvrir le lien dans Chrome → menu ⋮ → « Installer l'application ».

## Obtenir un vrai APK (Android, optionnel)
Une fois le site en ligne : https://www.pwabuilder.com → coller l'URL → Package → Android → télécharger.
Le `.apk` du zip s'installe directement (autoriser « sources inconnues »). Ça ne marche pas sur iPhone.

## Tester en local
`python3 -m http.server 8000` puis ouvrir http://localhost:8000

## Mettre à jour
Après une modif, change `CACHE = 'undercover-v1'` en `v2` dans `sw.js` pour que les téléphones récupèrent la nouvelle version.
Les mots sont dans `words.js` : ajoute des paires `["Mot civil", "Mot undercover"]` où tu veux.
