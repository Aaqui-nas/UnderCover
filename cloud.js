// Synchronisation des paires de mots partagées avec Firestore.
// Expose window.cloud = { add, remove } et prévient app.js via
// window.onSharedPairs(pairs) et window.onCloudStatus(status).
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const MAX_LEN = 40;

const setStatus = (s) => window.onCloudStatus?.(s);

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
  let db;
  try {
    // Cache IndexedDB : lecture hors-ligne et file d'attente des ajouts.
    db = fs.initializeFirestore(fbApp, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = fs.getFirestore(fbApp);
  }
  const auth = au.getAuth(fbApp);
  const pairsCol = fs.collection(db, 'pairs');

  // Connexion anonyme : identifie chaque téléphone pour qu'il ne puisse
  // supprimer que ses propres paires.
  // Hors-ligne, la session déjà enregistrée sur le téléphone suffit.
  await auth.authStateReady();
  const user = auth.currentUser || (await au.signInAnonymously(auth)).user;

  const report = (err) => {
    console.error(err);
    alert(err?.code === 'permission-denied'
      ? 'Refusé par le serveur (mots trop longs ou paire invalide).'
      : 'Erreur lors de la synchronisation des mots.');
  };

  window.cloud = {
    add(a, b) {
      fs.addDoc(pairsCol, {
        a: a.slice(0, MAX_LEN),
        b: b.slice(0, MAX_LEN),
        by: user.uid,
        createdAt: fs.serverTimestamp(),
      }).catch(report);
    },
    remove(id) {
      fs.deleteDoc(fs.doc(db, 'pairs', id)).catch(report);
    },
  };

  fs.onSnapshot(pairsCol, { includeMetadataChanges: true }, (snap) => {
    const pairs = snap.docs.map((d) => {
      const data = d.data({ serverTimestamps: 'estimate' });
      return {
        id: d.id,
        a: data.a,
        b: data.b,
        mine: data.by === user.uid,
        pending: d.metadata.hasPendingWrites,
        t: data.createdAt?.toMillis?.() || 0,
      };
    }).sort((x, y) => y.t - x.t);
    setStatus(snap.metadata.fromCache ? 'offline' : 'online');
    window.onSharedPairs?.(pairs);
  }, (err) => {
    console.error(err);
    setStatus('error');
  });
}

start().catch((err) => {
  console.error(err);
  // SDK non chargé (hors-ligne au premier lancement) : on garde la copie locale.
  setStatus(navigator.onLine ? 'error' : 'offline');
});
