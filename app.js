const STORAGE_KEY = 'undercover-v1';
const POINTS = { civil: 2, under: 10, white: 6 };
const ROLE_LABEL = { civil: 'Civil', under: 'Undercover', white: 'Mr. White' };
const CUSTOM_CAT = 'Mots perso';
const SHARED_CAT = 'Mots partagés';
const SHARED_KEY = 'undercover-shared';

const app = document.getElementById('app');

let state = load() || {
  players: [],
  undercover: 1,
  white: 0,
  categories: Object.keys(WORD_CATEGORIES),
  customPairs: [],
  scores: {},
  usedPairs: [],
  screen: 'home',
  game: null,
};
let ui = { overlay: null, peek: null };

// Paires partagées via Firebase (cloud.js). Copie locale pour jouer hors-ligne
// même si le SDK Firebase ne se charge pas.
let sharedPairs = [];
try { sharedPairs = JSON.parse(localStorage.getItem(SHARED_KEY)) || []; } catch {}
let cloudStatus = 'off'; // off | connecting | online | offline | error

window.onSharedPairs = (pairs) => {
  sharedPairs = pairs;
  try { localStorage.setItem(SHARED_KEY, JSON.stringify(pairs)); } catch {}
  if (pairs.length && !state.sharedCatInit) {
    state.sharedCatInit = true;
    if (!state.categories.includes(SHARED_CAT)) state.categories.push(SHARED_CAT);
  }
  if (['home', 'custom'].includes(state.screen)) render();
};
window.onCloudStatus = (status) => {
  cloudStatus = status;
  if (state.screen === 'custom') render();
};

function load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

function allCategories() {
  const cats = { ...WORD_CATEGORIES };
  if (sharedPairs.length) cats[SHARED_CAT] = sharedPairs.map((p) => [p.a, p.b]);
  if (state.customPairs.length) cats[CUSTOM_CAT] = state.customPairs;
  return cats;
}

function limits() {
  const n = state.players.length;
  return { n, civil: n - state.undercover - state.white };
}

function canStart() {
  const { n, civil } = limits();
  const impostors = state.undercover + state.white;
  return n >= 3 && impostors >= 1 && civil >= 2 && impostors <= civil && pairPool().length > 0;
}

function pairPool() {
  const cats = allCategories();
  return state.categories.filter((c) => cats[c]).flatMap((c) => cats[c]);
}

function choosePair() {
  const pool = pairPool();
  const key = (p) => p.join('|');
  let fresh = pool.filter((p) => !state.usedPairs.includes(key(p)));
  if (!fresh.length) {
    const poolKeys = new Set(pool.map(key));
    state.usedPairs = state.usedPairs.filter((k) => !poolKeys.has(k));
    fresh = pool;
  }
  const pair = pick(fresh);
  state.usedPairs.push(key(pair));
  if (state.usedPairs.length > 1500) state.usedPairs = state.usedPairs.slice(-1500);
  return Math.random() < 0.5 ? pair : [pair[1], pair[0]];
}

// ---------- Game logic ----------

function startGame() {
  const [civilWord, underWord] = choosePair();
  const roles = shuffle([
    ...Array(state.undercover).fill('under'),
    ...Array(state.white).fill('white'),
    ...Array(limits().civil).fill('civil'),
  ]);
  state.game = {
    civilWord,
    underWord,
    players: state.players.map((name, i) => ({
      name,
      role: roles[i],
      word: roles[i] === 'civil' ? civilWord : roles[i] === 'under' ? underWord : null,
      alive: true,
      seen: false,
    })),
    dealIndex: null,
    round: 1,
    starter: null,
    eliminated: null,
    whiteGuess: null,
    winner: null,
  };
  state.screen = 'deal';
}

function pickStarter() {
  const g = state.game;
  const candidates = g.players.filter((p) => p.alive && p.role !== 'white');
  g.starter = pick(candidates.length ? candidates : g.players.filter((p) => p.alive)).name;
}

function aliveCount(role) {
  return state.game.players.filter((p) => p.alive && p.role === role).length;
}

function checkWinner() {
  const g = state.game;
  if (aliveCount('under') === 0 && aliveCount('white') === 0) return ['civil'];
  if (aliveCount('civil') <= 1) {
    const w = [];
    if (aliveCount('under') > 0) w.push('under');
    if (aliveCount('white') > 0) w.push('white');
    return w;
  }
  return null;
}

function endGame(winnerRoles) {
  const g = state.game;
  g.winner = winnerRoles;
  for (const p of g.players) {
    if (winnerRoles.includes(p.role)) {
      state.scores[p.name] = (state.scores[p.name] || 0) + POINTS[p.role];
    }
  }
  state.screen = 'end';
}

function eliminate(name) {
  const g = state.game;
  const p = g.players.find((x) => x.name === name);
  p.alive = false;
  g.eliminated = name;
  g.whiteGuess = null;
  state.screen = p.role === 'white' ? 'whiteGuess' : 'reveal';
}

function afterReveal() {
  const winner = checkWinner();
  if (winner) return endGame(winner);
  state.game.round++;
  pickStarter();
  state.screen = 'game';
}

// ---------- Rendering ----------

function render() {
  const screens = { home, custom, scores, deal, game, whiteGuess, reveal, end };
  // Conserve la saisie en cours si la liste partagée se met à jour pendant qu'on tape.
  const typed = [...app.querySelectorAll('input[name]')].map((i) => [i.closest('form')?.dataset.form, i.name, i.value]);
  const focused = document.activeElement?.name;
  app.innerHTML = (screens[state.screen] || home)() + overlay();
  for (const [form, name, value] of typed) {
    const el = app.querySelector(`[data-form="${form}"] [name="${name}"]`);
    if (el && value) el.value = value;
  }
  if (focused) app.querySelector(`input[name="${focused}"]`)?.focus();
  save();
  const input = app.querySelector('[autofocus]');
  if (input && !('ontouchstart' in window)) input.focus();
}

function home() {
  const { n, civil } = limits();
  const cats = allCategories();
  const poolSize = pairPool().length;
  let warning = '';
  if (n < 3) warning = 'Il faut au moins 3 joueurs.';
  else if (state.undercover + state.white < 1) warning = 'Il faut au moins un Undercover ou un Mr. White.';
  else if (civil < 2 || state.undercover + state.white > civil) warning = 'Trop d\'imposteurs pour le nombre de joueurs.';
  else if (!poolSize) warning = 'Sélectionne au moins une catégorie.';

  return `
    <h1>Under<span>cover</span></h1>
    <div class="card">
      <div class="row between"><h2>Joueurs (${n})</h2>
        ${n ? '<button class="ghost small" data-action="shufflePlayers">🔀 Mélanger</button>' : ''}
      </div>
      <form class="row" data-form="addPlayer">
        <input type="text" name="name" placeholder="Nom du joueur" maxlength="20" autocomplete="off" enterkeyhint="done">
        <button class="round" type="submit">+</button>
      </form>
      <div class="players">
        ${state.players.map((p, i) => `
          <div class="player">
            <span class="name">${esc(p)}</span>
            <button class="ghost small" data-action="moveUp" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="ghost small" data-action="removePlayer" data-i="${i}">✕</button>
          </div>`).join('')}
      </div>
    </div>

    <div class="card">
      <h2>Rôles</h2>
      <div class="row between">
        <span><span class="role-civil">●</span> Civils</span>
        <span class="stepper"><span class="val">${Math.max(civil, 0)}</span></span>
      </div>
      ${stepper('Undercover', 'role-under', 'undercover', state.undercover)}
      ${stepper('Mr. White', 'role-white', 'white', state.white)}
    </div>

    <div class="card">
      <div class="row between"><h2>Catégories</h2>
        <button class="ghost small" data-action="toggleAllCats">Tout / rien</button>
      </div>
      <div class="chips">
        ${Object.keys(cats).map((c) => `
          <button class="chip ${state.categories.includes(c) ? 'on' : ''}" data-action="toggleCat" data-cat="${esc(c)}">${esc(c)} · ${cats[c].length}</button>`).join('')}
      </div>
      <p class="muted">${poolSize} paires de mots sélectionnées</p>
    </div>

    <div class="row">
      <button class="grow" data-action="go" data-screen="custom">✏️ Ajouter des mots</button>
      <button class="grow" data-action="go" data-screen="scores">🏆 Scores</button>
    </div>

    ${warning ? `<p class="center" style="color:var(--warn)">${warning}</p>` : ''}
    <button class="primary" data-action="start" ${canStart() ? '' : 'disabled'}>Lancer la partie</button>
  `;
}

function stepper(label, cls, key, val) {
  return `
    <div class="row between">
      <span><span class="${cls}">●</span> ${label}</span>
      <span class="stepper">
        <button class="round" data-action="dec" data-key="${key}" ${val <= 0 ? 'disabled' : ''}>−</button>
        <span class="val">${val}</span>
        <button class="round" data-action="inc" data-key="${key}">+</button>
      </span>
    </div>`;
}

const CLOUD_LABEL = {
  off: 'Partage non configuré : les mots restent sur ce téléphone.',
  connecting: 'Connexion…',
  online: '☁️ Connecté : les mots ajoutés sont visibles par tout le monde.',
  offline: '📴 Hors-ligne : tes ajouts seront envoyés au retour du réseau.',
  error: '⚠️ Impossible de joindre le serveur de mots partagés.',
};
const cloudReady = () => !!window.cloud && cloudStatus !== 'error';

function custom() {
  const shared = cloudReady();
  const mine = sharedPairs.filter((p) => p.mine);
  const others = sharedPairs.length - mine.length;
  return `
    <div class="row"><button class="ghost" data-action="go" data-screen="home">← Retour</button></div>
    <h2>Ajouter des mots</h2>
    <p class="muted">${!window.cloud && cloudStatus === 'offline'
      ? '📴 Hors-ligne : tes ajouts restent sur ce téléphone, tu pourras les partager plus tard.'
      : CLOUD_LABEL[cloudStatus]}</p>
    <form class="card" data-form="addPair">
      <input type="text" name="a" placeholder="Mot 1 (ex : Pizza)" maxlength="40" autocomplete="off">
      <input type="text" name="b" placeholder="Mot 2 proche (ex : Quiche)" maxlength="40" autocomplete="off">
      <button class="primary" type="submit">${shared ? 'Ajouter pour tout le monde' : 'Ajouter sur ce téléphone'}</button>
    </form>
    ${sharedPairs.length || shared ? `
      <h2>${SHARED_CAT} (${sharedPairs.length})</h2>
      <p class="muted">${others ? `${others} ajoutée${others > 1 ? 's' : ''} par les autres. ` : ''}Tu peux supprimer uniquement celles que tu as ajoutées.</p>
      <div class="list">
        ${mine.map((p) => `
          <div class="item"><span>${esc(p.a)} / ${esc(p.b)}${p.pending ? ' <span class="muted">· envoi…</span>' : ''}</span>
            <button class="ghost small" data-action="removeShared" data-id="${esc(p.id)}">✕</button></div>`).join('')
          || '<p class="muted center">Tu n\'as encore rien ajouté.</p>'}
      </div>` : ''}
    ${state.customPairs.length ? `
      <h2>Sur ce téléphone uniquement (${state.customPairs.length})</h2>
      <div class="list">
        ${state.customPairs.map((p, i) => `
          <div class="item"><span>${esc(p[0])} / ${esc(p[1])}</span>
            <span class="row">
              ${shared ? `<button class="ghost small" data-action="sharePair" data-i="${i}">☁️ Partager</button>` : ''}
              <button class="ghost small" data-action="removePair" data-i="${i}">✕</button>
            </span></div>`).join('')}
      </div>` : ''}
  `;
}

function pairExists(a, b) {
  const key = (x, y) => [normalize(x), normalize(y)].sort().join('|');
  const k = key(a, b);
  return Object.values(allCategories()).some((pairs) => pairs.some((p) => key(p[0], p[1]) === k));
}

function scores() {
  const rows = Object.entries(state.scores).sort((a, b) => b[1] - a[1]);
  return `
    <div class="row"><button class="ghost" data-action="go" data-screen="home">← Retour</button></div>
    <h2>🏆 Scores</h2>
    <p class="muted">Civil gagnant : ${POINTS.civil} pts · Mr. White : ${POINTS.white} pts · Undercover : ${POINTS.under} pts</p>
    <div class="list">
      ${rows.map(([name, pts], i) => `
        <div class="item"><span>${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} ${esc(name)}</span><strong>${pts}</strong></div>`).join('')
        || '<p class="muted center">Pas encore de score.</p>'}
    </div>
    ${rows.length ? '<button class="danger" data-action="resetScores">Remettre les scores à zéro</button>' : ''}
  `;
}

function wordCard(p) {
  if (p.role === 'white') {
    return `<div class="big-card" style="background:linear-gradient(160deg,#3a3650,#1f1c30)">
      <div class="label">Tu es</div><div class="word">Mr. White 🤫</div>
      <p>Tu n'as pas de mot. Écoute les autres et bluffe !</p></div>`;
  }
  return `<div class="big-card"><div class="label">Ton mot</div><div class="word">${esc(p.word)}</div></div>`;
}

function deal() {
  const g = state.game;
  if (g.dealIndex !== null) {
    const p = g.players[g.dealIndex];
    return `
      <h2 class="center">${esc(p.name)}</h2>
      ${wordCard(p)}
      <button class="primary" data-action="hideWord">J'ai retenu, cacher</button>
    `;
  }
  const allSeen = g.players.every((p) => p.seen);
  return `
    <h2>Distribution des mots</h2>
    <p class="muted">Chacun son tour : prends le téléphone, touche ton nom, mémorise ton mot sans le montrer.</p>
    <div class="grid">
      ${g.players.map((p, i) => `
        <button class="tile ${p.seen ? 'done' : ''}" data-action="showWord" data-i="${i}" ${p.seen ? 'disabled' : ''}>
          ${esc(p.name)}${p.seen ? '<span class="tag">✓ vu</span>' : ''}</button>`).join('')}
    </div>
    <div class="grow"></div>
    <button class="primary" data-action="beginRounds" ${allSeen ? '' : 'disabled'}>Tout le monde a vu son mot</button>
    <button class="ghost" data-action="quit">Abandonner la partie</button>
  `;
}

function game() {
  const g = state.game;
  return `
    <div class="row between"><h2>Tour ${g.round}</h2>
      <button class="ghost small" data-action="openPeek">👁 Revoir mon mot</button></div>
    <div class="card center">
      <p class="muted">C'est</p>
      <h2>${esc(g.starter)}</h2>
      <p class="muted">qui commence. Chacun donne un indice sur son mot, puis votez !</p>
    </div>
    <p class="muted">Touchez le joueur éliminé par le vote :</p>
    <div class="grid">
      ${g.players.map((p) => p.alive
        ? `<button class="tile" data-action="askEliminate" data-name="${esc(p.name)}">${esc(p.name)}</button>`
        : `<div class="tile dead">${esc(p.name)}<span class="tag ${roleClass(p.role)}">${ROLE_LABEL[p.role]}</span></div>`).join('')}
    </div>
    <div class="grow"></div>
    <button class="ghost" data-action="quit">Abandonner la partie</button>
  `;
}

const roleClass = (r) => ({ civil: 'role-civil', under: 'role-under', white: 'role-white' }[r]);

function reveal() {
  const g = state.game;
  const p = g.players.find((x) => x.name === g.eliminated);
  const emoji = { civil: '😇', under: '🕵️', white: '👻' }[p.role];
  return `
    <div class="grow"></div>
    <div class="banner ${p.role}">
      <div class="emoji">${emoji}</div>
      <h2>${esc(p.name)} était</h2>
      <h1 class="${roleClass(p.role)}">${ROLE_LABEL[p.role]}</h1>
      ${g.whiteGuess ? `<p class="muted">A proposé « ${esc(g.whiteGuess)} » — raté !</p>` : ''}
    </div>
    <div class="grow"></div>
    <button class="primary" data-action="continue">Continuer</button>
  `;
}

function whiteGuess() {
  const g = state.game;
  return `
    <div class="banner white">
      <div class="emoji">👻</div>
      <h2>${esc(g.eliminated)} était Mr. White !</h2>
      <p>Dernière chance : devine le mot des civils pour gagner.</p>
    </div>
    <form class="card" data-form="whiteGuess">
      <input type="text" name="guess" placeholder="Le mot des civils…" autocomplete="off" autofocus>
      <button class="primary" type="submit">Valider</button>
    </form>
    ${g.whiteGuess ? `
      <div class="card center">
        <p>« ${esc(g.whiteGuess)} » n'est pas exactement le mot.</p>
        <p class="muted">Le mot était <strong>${esc(g.civilWord)}</strong>. Faute de frappe ou synonyme accepté par le groupe ?</p>
        <div class="row">
          <button class="grow" data-action="whiteAccept">✓ On accepte</button>
          <button class="grow danger" data-action="whiteReject">✕ Raté</button>
        </div>
      </div>` : ''}
  `;
}

function end() {
  const g = state.game;
  const w = g.winner;
  const cls = w.includes('under') ? 'under' : w.includes('white') ? 'white' : 'civil';
  const title = w.includes('civil') ? 'Les Civils gagnent !'
    : w.length === 2 ? 'Undercover et Mr. White gagnent !'
    : w.includes('under') ? 'L\'Undercover gagne !' : 'Mr. White gagne !';
  const emoji = { civil: '🎉', under: '🕵️', white: '👻' }[cls];
  return `
    <div class="banner ${cls}">
      <div class="emoji">${emoji}</div>
      <h1>${title}</h1>
    </div>
    <div class="card">
      <div class="row between"><span class="role-civil">Mot civil</span><strong>${esc(g.civilWord)}</strong></div>
      <div class="row between"><span class="role-under">Mot undercover</span><strong>${esc(g.underWord)}</strong></div>
    </div>
    <div class="list">
      ${g.players.map((p) => `
        <div class="item">
          <span>${p.alive ? '' : '💀 '}${esc(p.name)}</span>
          <span class="${roleClass(p.role)}">${ROLE_LABEL[p.role]}${w.includes(p.role) ? ` +${POINTS[p.role]}` : ''}</span>
        </div>`).join('')}
    </div>
    <button class="primary" data-action="replay">Rejouer (mêmes joueurs)</button>
    <div class="row">
      <button class="grow" data-action="toHome">Menu</button>
      <button class="grow" data-action="go" data-screen="scores">🏆 Scores</button>
    </div>
  `;
}

function overlay() {
  if (!ui.overlay) return '';
  const g = state.game;
  if (ui.overlay.type === 'confirm') {
    return `<div class="overlay"><div class="card center">
      <h2>${esc(ui.overlay.text)}</h2>
      <div class="row">
        <button class="grow" data-action="closeOverlay">Annuler</button>
        <button class="grow danger" data-action="confirmOverlay">Confirmer</button>
      </div></div></div>`;
  }
  if (ui.overlay.type === 'peek') {
    if (ui.peek !== null) {
      const p = g.players[ui.peek];
      return `<div class="overlay"><div class="card" style="min-height:60vh">
        <h2 class="center">${esc(p.name)}</h2>${wordCard(p)}
        <button class="primary" data-action="closeOverlay">Cacher</button></div></div>`;
    }
    return `<div class="overlay"><div class="card">
      <h2>Qui veut revoir son mot ?</h2>
      <div class="grid">${g.players.map((p, i) => p.alive
        ? `<button class="tile" data-action="peek" data-i="${i}">${esc(p.name)}</button>` : '').join('')}</div>
      <button class="ghost" data-action="closeOverlay">Annuler</button></div></div>`;
  }
  return '';
}

// ---------- Events ----------

function confirm(text, onYes) {
  ui.overlay = { type: 'confirm', text, onYes };
}

const actions = {
  go: (d) => { state.screen = d.screen; },
  shufflePlayers: () => { state.players = shuffle(state.players); },
  moveUp: (d) => { const i = +d.i; [state.players[i - 1], state.players[i]] = [state.players[i], state.players[i - 1]]; },
  removePlayer: (d) => { state.players.splice(+d.i, 1); },
  inc: (d) => { state[d.key]++; },
  dec: (d) => { state[d.key] = Math.max(0, state[d.key] - 1); },
  toggleCat: (d) => {
    const i = state.categories.indexOf(d.cat);
    if (i >= 0) state.categories.splice(i, 1); else state.categories.push(d.cat);
  },
  toggleAllCats: () => {
    const all = Object.keys(allCategories());
    state.categories = state.categories.length === all.length ? [] : all;
  },
  removePair: (d) => { state.customPairs.splice(+d.i, 1); },
  removeShared: (d) => {
    const p = sharedPairs.find((x) => x.id === d.id);
    if (p) confirm(`Supprimer « ${p.a} / ${p.b} » pour tout le monde ?`, () => window.cloud.remove(p.id));
  },
  sharePair: (d) => {
    const [a, b] = state.customPairs[+d.i];
    window.cloud.add(a, b);
    state.customPairs.splice(+d.i, 1);
  },
  resetScores: () => confirm('Remettre tous les scores à zéro ?', () => { state.scores = {}; }),
  start: () => { if (canStart()) startGame(); },
  showWord: (d) => { state.game.dealIndex = +d.i; },
  hideWord: () => { const g = state.game; g.players[g.dealIndex].seen = true; g.dealIndex = null; },
  beginRounds: () => { pickStarter(); state.screen = 'game'; },
  openPeek: () => { ui.overlay = { type: 'peek' }; ui.peek = null; },
  peek: (d) => { ui.peek = +d.i; },
  askEliminate: (d) => confirm(`Éliminer ${d.name} ?`, () => eliminate(d.name)),
  continue: afterReveal,
  whiteAccept: () => endGame(['white']),
  whiteReject: () => { state.screen = 'reveal'; },
  replay: () => { if (canStart()) startGame(); else state.screen = 'home'; },
  toHome: () => { state.game = null; state.screen = 'home'; },
  quit: () => confirm('Abandonner la partie en cours ?', () => { state.game = null; state.screen = 'home'; }),
  closeOverlay: () => { ui.overlay = null; ui.peek = null; },
  confirmOverlay: () => { const fn = ui.overlay.onYes; ui.overlay = null; fn(); },
};

const forms = {
  addPlayer: (f) => {
    const name = f.elements.name.value.trim();
    if (!name) return false;
    if (state.players.some((p) => p.toLowerCase() === name.toLowerCase())) { alert('Ce nom est déjà pris.'); return false; }
    state.players.push(name);
  },
  addPair: (f) => {
    const a = f.elements.a.value.trim(), b = f.elements.b.value.trim();
    if (!a || !b) return false;
    if (normalize(a) === normalize(b)) { alert('Les deux mots doivent être différents.'); return false; }
    if (pairExists(a, b)) { alert('Cette paire existe déjà.'); return false; }
    f.reset(); // avant l'envoi : la mise à jour de la liste re-rend l'écran
    if (cloudReady()) {
      window.cloud.add(a, b);
    } else {
      state.customPairs.push([a, b]);
      if (!state.categories.includes(CUSTOM_CAT)) state.categories.push(CUSTOM_CAT);
    }
  },
  whiteGuess: (f) => {
    const guess = f.elements.guess.value.trim();
    if (!guess) return false;
    const g = state.game;
    if (normalize(guess) === normalize(g.civilWord)) return endGame(['white']);
    g.whiteGuess = guess;
  },
};

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  fn(el.dataset);
  render();
});

app.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const fn = forms[form.dataset.form];
  if (!fn) return;
  if (fn(form) === false) return;
  render();
  const again = app.querySelector(`[data-form="${form.dataset.form}"] input`);
  if (again && form.dataset.form !== 'whiteGuess') again.focus();
});

// Sécurité : on ne rouvre jamais l'app sur un mot affiché.
if (state.game) state.game.dealIndex = null;
render();
