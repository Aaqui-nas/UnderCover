// Synchronisation des paires de mots avec Firestore.
// Expose window.cloud (paires, notes, corbeille, agents) et prévient app.js via
// window.onPairs(pairs), window.onAgents(agents) (listes complètes venant du
// serveur) et window.onCloudStatus(status).
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
    // Suppression : la paire part dans la corbeille partagée (restaurable).
    remove(p) {
      const batch = fs.writeBatch(db);
      batch.set(fs.doc(fs.collection(db, 'trash')), {
        a: p.a, b: p.b, cat: p.cat || 'Divers', up: p.up || 0, down: p.down || 0,
        pairId: p.id, deletedAt: fs.serverTimestamp(),
      });
      batch.delete(fs.doc(db, 'pairs', p.id));
      return batch.commit().catch((err) => {
        console.error(err);
        window.toast?.('Suppression impossible.');
      });
    },
    rate(id, vote) {
      return fs.updateDoc(fs.doc(db, 'pairs', id), { [vote > 0 ? 'up' : 'down']: fs.increment(1) });
    },
    async listTrash() {
      const q = fs.query(fs.collection(db, 'trash'), fs.orderBy('deletedAt', 'desc'), fs.limit(100));
      const snap = await fs.getDocs(q);
      return snap.docs.map((d) => {
        const { a, b, cat, up, down, pairId, deletedAt } = d.data();
        return { id: d.id, a, b, cat, up, down, pairId, deletedAt: deletedAt?.toMillis?.() || 0 };
      });
    },
    // Agents : écritures fusionnées, donc rejouables sans risque.
    agentSet(id, fields) {
      const data = { ...fields };
      if (data.createdAt === true) data.createdAt = fs.serverTimestamp();
      return fs.setDoc(fs.doc(db, 'agents', id), data, { merge: true });
    },
    // Compteurs : incréments atomiques, justes même si deux téléphones jouent en même temps.
    agentInc(id, delta) {
      const data = Object.fromEntries(Object.entries(delta).filter(([, v]) => v).map(([k, v]) => [k, fs.increment(v)]));
      return fs.setDoc(fs.doc(db, 'agents', id), data, { merge: true });
    },
    agentDelete(id) {
      return fs.deleteDoc(fs.doc(db, 'agents', id));
    },
    restore(t) {
      const batch = fs.writeBatch(db);
      batch.set(fs.doc(db, 'pairs', t.pairId), {
        a: t.a, b: t.b, cat: t.cat, up: t.up || 0, down: t.down || 0,
        by: user.uid, createdAt: fs.serverTimestamp(),
      });
      batch.delete(fs.doc(db, 'trash', t.id));
      return batch.commit();
    },
  };

  fs.onSnapshot(pairsCol, { includeMetadataChanges: true }, (snap) => {
    // Seules les listes venant du serveur remplacent la copie du téléphone.
    if (snap.metadata.fromCache) return;
    const pairs = snap.docs
      .filter((d) => !d.metadata.hasPendingWrites)
      .map((d) => {
        const { a, b, cat, by, up, down } = d.data();
        return { id: d.id, a, b, cat, by, up: up || 0, down: down || 0 };
      });
    setStatus('online');
    window.onPairs?.(pairs);
  }, (err) => {
    console.error(err);
    setStatus('error');
  });

  fs.onSnapshot(fs.collection(db, 'agents'), (snap) => {
    if (snap.metadata.fromCache) return;
    window.onAgents?.(snap.docs.map((d) => {
      const { createdAt, ...data } = d.data({ serverTimestamps: 'estimate' });
      return { id: d.id, ...data };
    }));
  }, (err) => console.error(err));

  window.addEventListener('offline', () => setStatus('offline'));
}

start().catch((err) => {
  console.error(err);
  // SDK ou connexion indisponible : l'appli continue avec la copie du téléphone.
  setStatus(navigator.onLine ? 'error' : 'offline');
});
