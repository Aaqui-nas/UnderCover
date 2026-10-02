// Synchronisation des paires de mots avec Firestore.
// Expose window.cloud = { uid, add, remove } et prévient app.js via
// window.onPairs(pairs) (liste complète confirmée par le serveur) et
// window.onCloudStatus(status).
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const MAX_LEN = 40;
const MAX_CAT_LEN = 30;

let current = null;
const setStatus = (s) => {
  if (s === current) return;
  current = s;
  window.onCloudStatus?.(s);
};

async function start() {
  const config = window.FIREBASE_CONFIG;
  if (!config) return;
  setStatus('connecting');

  const [{ initializeApp }, fs, au] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-firestore.js`),
    import(`${SDK}/firebase-auth.js`),
  ]);

  const fbApp = initializeApp(config);
  // Pas de cache Firestore : la copie hors-ligne est gérée par app.js.
  const db = fs.getFirestore(fbApp);
  const auth = au.getAuth(fbApp);
  const pairsCol = fs.collection(db, 'pairs');

  // Connexion anonyme : identifie chaque téléphone pour qu'il ne puisse
  // supprimer que ses propres paires. La session est gardée sur le téléphone.
  await auth.authStateReady();
  const user = auth.currentUser || (await au.signInAnonymously(auth)).user;

  window.cloud = {
    uid: user.uid,
    // Identifiant choisi par l'appli : renvoyer la même paire ne crée jamais de doublon.
    add({ id, a, b, cat }) {
      return fs.setDoc(fs.doc(db, 'pairs', id), {
        a: a.slice(0, MAX_LEN),
        b: b.slice(0, MAX_LEN),
        cat: cat.slice(0, MAX_CAT_LEN),
        by: user.uid,
        createdAt: fs.serverTimestamp(),
      });
    },
    remove(id) {
      return fs.deleteDoc(fs.doc(db, 'pairs', id)).catch((err) => {
        console.error(err);
        alert('Suppression impossible.');
      });
    },
  };

  fs.onSnapshot(pairsCol, { includeMetadataChanges: true }, (snap) => {
    // Seules les listes venant du serveur remplacent la copie du téléphone.
    if (snap.metadata.fromCache) return;
    const pairs = snap.docs
      .filter((d) => !d.metadata.hasPendingWrites)
      .map((d) => {
        const { a, b, cat, by } = d.data();
        return { id: d.id, a, b, cat, by };
      });
    setStatus('online');
    window.onPairs?.(pairs);
  }, (err) => {
    console.error(err);
    setStatus('error');
  });

  window.addEventListener('offline', () => setStatus('offline'));
}

start().catch((err) => {
  console.error(err);
  // SDK ou connexion indisponible : l'appli continue avec la copie du téléphone.
  setStatus(navigator.onLine ? 'error' : 'offline');
});
