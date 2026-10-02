const STORAGE_KEY = 'undercover-v1';
const PAIRS_KEY = 'undercover-pairs';
const POINTS = { civil: 2, under: 10, white: 6 };
const ROLE_LABEL = { civil: 'Civil', under: 'Undercover', white: 'Mr. White' };
const DEFAULT_CAT = 'Divers';
const TIMER_CHOICES = [0, 60, 120, 180, 300];
const NEW_CAT = '__new';

const app = document.getElementById('app');

let state = load() || {};
state = {
  players: [],
  undercover: 1,
  white: 0,
  disabledCats: [],
  pendingPairs: [], // ajoutées hors-ligne, envoyées dès que la connexion revient
  scores: {},
  usedPairs: [],
  timer: 120, // durée de discussion par tour, en secondes (0 = sans chrono)
  screen: 'home',
  game: null,
  ...state,
};
if (state.screen === 'custom') state.screen = 'pairs';
// Ancienne version : paires gardées seulement sur le téléphone → à envoyer dans la base.
if (state.customPairs) {
  for (const [a, b] of state.customPairs) state.pendingPairs.push({ id: newId(), a, b, cat: 'Mots perso' });
  delete state.customPairs;
}
delete state.categories;
let ui = { overlay: null, peek: null, search: '', addOpen: false };

// Toutes les paires viennent de la base Firestore (cloud.js). La dernière liste
// reçue est gardée sur le téléphone pour jouer sans connexion.
let pairsCache = { pairs: [], syncedAt: 0 };
try { pairsCache = JSON.parse(localStorage.getItem(PAIRS_KEY)) || pairsCache; } catch {}
let cloudStatus = 'off'; // off | connecting | online | offline | error

window.onPairs = (pairs) => {
  pairsCache = { pairs, syncedAt: Date.now() };
  try { localStorage.setItem(PAIRS_KEY, JSON.stringify(pairsCache)); } catch {}
  // Une paire en attente qui apparaît dans la base est bien arrivée.
  const ids = new Set(pairs.map((p) => p.id));
  state.pendingPairs = state.pendingPairs.filter((p) => !ids.has(p.id));
  if (['home', 'pairs'].includes(state.screen)) render(); else save();
};
window.onCloudStatus = (status) => {
  cloudStatus = status;
  if (window.cloud) state.uid = window.cloud.uid;
  if (status === 'online') flushPending();
  if (['home', 'pairs'].includes(state.screen)) render();
};

const sending = new Set();

function sendPair(p) {
  if (sending.has(p.id)) return;
  sending.add(p.id);
  window.cloud.add(p)
    .catch((err) => {
      // Refusée par les règles (paire invalide ou déjà envoyée) : inutile de réessayer.
      if (err?.code !== 'permission-denied') return;
      if (!pairsCache.pairs.some((x) => x.id === p.id)) toast(`Paire « ${p.a} / ${p.b} » refusée par le serveur.`);
      state.pendingPairs = state.pendingPairs.filter((x) => x.id !== p.id);
      if (['home', 'pairs'].includes(state.screen)) render(); else save();
    })
    .finally(() => sending.delete(p.id));
}

function flushPending() {
  state.pendingPairs.forEach(sendPair);
}

function load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const collator = new Intl.Collator('fr');

// Paires de la base + celles en attente d'envoi.
function allPairs() {
  return [...pairsCache.pairs, ...state.pendingPairs.map((p) => ({ ...p, pending: true }))];
}

function allCategories() {
  const cats = {};
  for (const p of allPairs()) (cats[p.cat || DEFAULT_CAT] ||= []).push([p.a, p.b]);
  return Object.fromEntries(Object.entries(cats).sort(([x], [y]) => collator.compare(x, y)));
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
  return Object.keys(cats).filter((c) => !state.disabledCats.includes(c)).flatMap((c) => cats[c]);
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
  state.caseNo = (state.caseNo || 0) + 1;
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
  startTimer();
  state.screen = 'game';
}

// ---------- Chrono de discussion ----------

function startTimer() {
  const g = state.game;
  g.timer = state.timer ? { total: state.timer * 1000, endsAt: Date.now() + state.timer * 1000, left: null, done: false } : null;
}

function timeLeft(t) {
  return Math.max(0, t.endsAt ? t.endsAt - Date.now() : t.left);
}

const fmt = (ms) => {
  const sec = Math.ceil(ms / 1000);
  return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
};

let audio = null;
// iOS n'autorise le son qu'après un geste : on prépare l'audio au premier toucher.
function unlockAudio() {
  if (audio) return;
  try {
    audio = new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), gain = audio.createGain();
    gain.gain.value = 0;
    o.connect(gain).connect(audio.destination);
    o.start(); o.stop(audio.currentTime + 0.01);
  } catch { audio = null; }
}

function alarm() {
  navigator.vibrate?.([300, 120, 300, 120, 500]);
  if (!audio) return;
  audio.resume?.();
  [0, 0.28, 0.56].forEach((at, i) => {
    const o = audio.createOscillator(), gain = audio.createGain();
    o.type = 'square';
    o.frequency.value = i === 2 ? 660 : 880;
    gain.gain.setValueAtTime(0.18, audio.currentTime + at);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + at + 0.22);
    o.connect(gain).connect(audio.destination);
    o.start(audio.currentTime + at);
    o.stop(audio.currentTime + at + 0.24);
  });
}

// Garde l'écran allumé pendant le chrono : en veille, le téléphone ne sonnerait pas.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch { wakeLock = null; }
}
// Le verrou saute quand l'appli passe en arrière-plan : on le reprend au retour.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') render();
});

// Met à jour l'affichage sans tout redessiner (garde la page fluide).
setInterval(() => {
  const t = state.game?.timer;
  if (state.screen !== 'game' || !t || t.done) return;
  const left = timeLeft(t);
  const clock = app.querySelector('[data-clock]');
  const bar = app.querySelector('[data-bar]');
  if (clock) clock.textContent = fmt(left);
  if (bar) bar.style.transform = `scaleX(${left / t.total})`;
  if (left <= 0) {
    t.done = true;
    alarm();
    render();
  }
}, 250);

// ---------- Rendering ----------

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  back: '<path d="M20 12H5M11 6l-6 6 6 6"/>',
};
const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const pad = (n) => String(n).padStart(2, '0');
const roleClass = (r) => `c-${r}`;
const backLink = () => `<button class="link back" data-action="go" data-screen="home">${icon('back')} Retour</button>`;

function render() {
  const screens = { home, pairs: pairsScreen, scores, deal, game, whiteGuess, reveal, end };
  // Conserve la saisie en cours si la liste partagée se met à jour pendant qu'on tape.
  const typed = [...app.querySelectorAll('input[name], select[name]')].map((i) => [i.closest('form')?.dataset.form, i.name, i.value]);
  const focused = document.activeElement?.name;
  app.innerHTML = (screens[state.screen] || home)() + overlay();
  for (const [form, name, value] of typed) {
    const el = app.querySelector(`[data-form="${form}"] [name="${name}"]`);
    if (el && value) el.value = value;
  }
  if (focused) app.querySelector(`input[name="${focused}"]`)?.focus();
  syncNewCat();
  keepAwake(state.screen === 'game' && !!state.game?.timer && !state.game.timer.done);
  save();
  const input = app.querySelector('[autofocus]');
  if (input && !('ontouchstart' in window)) input.focus();
}

function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
window.toast = toast;

function syncLabel() {
  if (cloudStatus === 'online') return 'En ligne · à jour';
  if (cloudStatus === 'connecting') return 'Connexion…';
  if (!pairsCache.syncedAt) return 'Jamais synchronisé';
  const d = new Date(pairsCache.syncedAt);
  return `Hors ligne · ${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })}`;
}

function home() {
  const { n, civil } = limits();
  const cats = allCategories();
  const poolSize = pairPool().length;
  let warning = '';
  if (n < 3) warning = 'Il faut au moins 3 agents.';
  else if (state.undercover + state.white < 1) warning = 'Il faut au moins un Undercover ou un Mr. White.';
  else if (civil < 2 || state.undercover + state.white > civil) warning = 'Trop d\'imposteurs pour le nombre d\'agents.';
  else if (!pairsCache.pairs.length && !state.pendingPairs.length) warning = 'Aucun mot sur ce téléphone. Lance l\'appli une première fois avec internet pour les télécharger.';
  else if (!poolSize) warning = 'Coche au moins une catégorie.';
  const statusCls = cloudStatus === 'online' ? 'online' : pairsCache.syncedAt && cloudStatus !== 'connecting' ? 'offline' : '';

  return `
    <header class="masthead">
      <div class="meta">
        <span class="label">N° ${String((state.caseNo || 0) + 1).padStart(3, '0')}</span>
        <span class="label status ${statusCls}">${syncLabel()}</span>
      </div>
      <h1 class="display">Undercover</h1>
      <div class="rules"></div>
    </header>

    <section class="section">
      <div class="section-head">
        <span class="label"><span class="num">01</span>Agents · ${n}</span>
        ${n > 1 ? '<button class="link" data-action="shufflePlayers">Mélanger</button>' : ''}
      </div>
      <form class="inline-form" data-form="addPlayer">
        <input type="text" name="name" placeholder="Nom de l'agent" maxlength="20" autocomplete="off" enterkeyhint="done">
        <button class="icon-btn solid" type="submit" aria-label="Ajouter l'agent">${icon('plus')}</button>
      </form>
      ${n ? `<ol class="roster">
        ${state.players.map((p, i) => `
          <li>
            <span class="n">${pad(i + 1)}</span>
            <span class="name">${esc(p)}</span>
            <button class="icon-btn" data-action="moveUp" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Monter ${esc(p)}">${icon('up')}</button>
            <button class="icon-btn" data-action="removePlayer" data-i="${i}" aria-label="Retirer ${esc(p)}">${icon('close')}</button>
          </li>`).join('')}
      </ol>` : '<p class="empty">Ajoute au moins 3 agents.</p>'}
    </section>

    <section class="section">
      <div class="section-head"><span class="label"><span class="num">02</span>Rôles</span></div>
      <div class="roles">
        <div class="role civil">
          <span class="count">${Math.max(civil, 0)}</span>
          <span class="label">Civils</span>
          <span class="fixed">le reste</span>
        </div>
        ${roleColumn('Undercover', 'under', 'undercover')}
        ${roleColumn('Mr. White', 'white', 'white')}
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <span class="label"><span class="num">03</span>Catégories · ${poolSize} paires</span>
        ${Object.keys(cats).length ? `<button class="link" data-action="toggleAllCats">${state.disabledCats.length ? 'Tout cocher' : 'Tout décocher'}</button>` : ''}
      </div>
      ${Object.keys(cats).length ? `<div class="cats">
        ${Object.keys(cats).map((c) => `
          <button class="cat ${state.disabledCats.includes(c) ? '' : 'on'}" data-action="toggleCat" data-cat="${esc(c)}" aria-pressed="${!state.disabledCats.includes(c)}">
            <span class="box"></span><span class="cname">${esc(c)}</span><span class="ccount">${cats[c].length}</span>
          </button>`).join('')}
      </div>` : `<p class="empty">${cloudStatus === 'connecting' ? 'Téléchargement des mots…' : 'Aucune catégorie pour l\'instant.'}</p>`}
    </section>

    <section class="section">
      <div class="section-head"><span class="label"><span class="num">04</span>Chrono de discussion</span></div>
      <div class="segmented" role="radiogroup" aria-label="Durée de discussion par tour">
        ${TIMER_CHOICES.map((v) => `
          <button class="seg ${state.timer === v ? 'on' : ''}" role="radio" aria-checked="${state.timer === v}" data-action="setTimer" data-v="${v}">${v ? `${v / 60} min` : 'Sans'}</button>`).join('')}
      </div>
      <p class="sub">${state.timer ? `Chaque tour dure ${state.timer / 60} min, puis ça sonne : place au vote.` : 'Pas de limite de temps.'}</p>
    </section>

    <div class="links">
      <button class="link" data-action="go" data-screen="pairs">Gérer les paires</button>
      <button class="link" data-action="go" data-screen="scores">Scores</button>
    </div>

    <div class="dock">
      ${warning ? `<p class="notice">${warning}</p>` : ''}
      <button class="btn" data-action="start" ${canStart() ? '' : 'disabled'}>Lancer la partie</button>
    </div>
  `;
}

function roleColumn(label, cls, key) {
  const val = state[key];
  return `
    <div class="role ${cls}">
      <span class="count">${val}</span>
      <span class="label">${label}</span>
      <span class="ctrl">
        <button class="icon-btn boxed" data-action="dec" data-key="${key}" ${val <= 0 ? 'disabled' : ''} aria-label="Moins de ${label}">${icon('minus')}</button>
        <button class="icon-btn boxed" data-action="inc" data-key="${key}" aria-label="Plus de ${label}">${icon('plus')}</button>
      </span>
    </div>`;
}

function pairsScreen() {
  const cats = Object.keys(allCategories());
  const selected = cats.includes(state.lastCat) ? state.lastCat : cats[0];
  const online = cloudStatus === 'online';
  return `
    ${backLink()}
    <div class="screen-head"><h2 class="display">Les paires</h2><span class="label">${allPairs().length} au total</span></div>
    <p class="muted">${online
      ? 'Connecté : ajouts et suppressions sont visibles par tout le monde.'
      : 'Hors ligne : tu peux ajouter des paires (envoyées au retour d\'internet), mais pas en supprimer.'}</p>
    ${ui.addOpen ? `
      <form class="form-card adder" data-form="addPair">
        <label class="field"><span class="label">Mot 1</span>
          <input type="text" name="a" placeholder="Pizza" maxlength="40" autocomplete="off"></label>
        <label class="field"><span class="label">Mot 2, proche du premier</span>
          <input type="text" name="b" placeholder="Quiche" maxlength="40" autocomplete="off"></label>
        <label class="field"><span class="label">Catégorie</span>
          <select name="cat">
            ${cats.map((c) => `<option value="${esc(c)}" ${c === selected ? 'selected' : ''}>${esc(c)}</option>`).join('')}
            <option value="${NEW_CAT}" ${cats.length ? '' : 'selected'}>Nouvelle catégorie…</option>
          </select></label>
        <label class="field"><span class="label">Nom de la nouvelle catégorie</span>
          <input type="text" name="newCat" placeholder="Soirées" maxlength="30" autocomplete="off"></label>
        <div class="row2">
          <button class="btn outline" type="button" data-action="toggleAdd">Fermer</button>
          <button class="btn" type="submit">Ajouter</button>
        </div>
      </form>`
      : '<button class="btn outline" data-action="toggleAdd">Ajouter une paire</button>'}
    <input type="search" name="q" value="${esc(ui.search)}" placeholder="Mot ou catégorie" autocomplete="off" enterkeyhint="search">
    <div id="pair-list">${pairsList()}</div>
  `;
}

function pairsList() {
  const q = normalize(ui.search);
  const groups = {};
  for (const p of allPairs()) {
    const cat = p.cat || DEFAULT_CAT;
    if (q && ![p.a, p.b, cat].some((x) => normalize(x).includes(q))) continue;
    (groups[cat] ||= []).push(p);
  }
  const names = Object.keys(groups).sort(collator.compare);
  if (!names.length) return `<p class="empty">${ui.search ? 'Aucune paire ne correspond.' : 'Aucune paire pour l\'instant.'}</p>`;
  return names.map((cat) => `
    <section class="section group">
      <div class="section-head"><span class="label">${esc(cat)} · ${groups[cat].length}</span></div>
      <div class="table">
        ${groups[cat].sort((x, y) => collator.compare(x.a, y.a)).map((p) => `
          <div class="tr">
            <span class="strong fill">${esc(p.a)} <span class="slash">/</span> ${esc(p.b)}</span>
            ${p.pending ? '<span class="mini-stamp c-under">En attente</span>' : ''}
            <button class="icon-btn" data-action="removePair" data-id="${esc(p.id)}" aria-label="Supprimer ${esc(p.a)} / ${esc(p.b)}">${icon('close')}</button>
          </div>`).join('')}
      </div>
    </section>`).join('');
}

// Affiche le champ « nouvelle catégorie » seulement quand on l'a choisi.
function syncNewCat() {
  const select = app.querySelector('select[name="cat"]');
  const input = app.querySelector('input[name="newCat"]');
  if (select && input) input.closest('.field').hidden = select.value !== NEW_CAT;
}

function pairExists(a, b) {
  const key = (x, y) => [normalize(x), normalize(y)].sort().join('|');
  const k = key(a, b);
  return allPairs().some((p) => key(p.a, p.b) === k);
}

function scores() {
  const rows = Object.entries(state.scores).sort((a, b) => b[1] - a[1]);
  return `
    ${backLink()}
    <div class="screen-head"><h2 class="display">Scores</h2></div>
    <p class="muted">Victoire : civil ${POINTS.civil} pts · Mr. White ${POINTS.white} pts · Undercover ${POINTS.under} pts</p>
    ${rows.length ? `<div class="table">
      ${rows.map(([name, pts], i) => `
        <div class="tr">
          <span class="rank">${pad(i + 1)}</span>
          <span class="strong fill">${esc(name)}</span>
          <span class="pts">${pts}</span>
        </div>`).join('')}
    </div>
    <button class="link red" data-action="resetScores">Remettre les scores à zéro</button>`
    : '<p class="empty">Pas encore de score. Joue une partie.</p>'}
  `;
}

function wordCard(p, index) {
  return `
    <div class="dossier">
      <div class="top"><span class="label">Agent ${pad(index + 1)}</span><span class="label">Usage strictement personnel</span></div>
      <div class="who-big">${esc(p.name)}</div>
      <div class="body">
        <span class="label">Ton mot</span>
        ${p.role === 'white'
          ? `<div class="redacted"></div>
             <p>Tu es <strong>Mr. White</strong>. Tu n'as pas de mot : écoute les autres et bluffe.</p>`
          : `<div class="word">${esc(p.word)}</div>`}
      </div>
      <div class="stamp-corner">Top secret</div>
    </div>`;
}

function deal() {
  const g = state.game;
  if (g.dealIndex !== null) {
    return `
      ${wordCard(g.players[g.dealIndex], g.dealIndex)}
      <button class="btn" data-action="hideWord">Retenu, fermer le dossier</button>
    `;
  }
  const seen = g.players.filter((p) => p.seen).length;
  return `
    <div class="screen-head"><h2 class="display">Distribution</h2><span class="label">${seen} / ${g.players.length}</span></div>
    <p class="muted">Chacun son tour : prends le téléphone, touche ton nom et mémorise ton mot sans le montrer.</p>
    <div class="files">
      ${g.players.map((p, i) => `
        <button class="file ${p.seen ? 'done' : ''}" data-action="showWord" data-i="${i}" ${p.seen ? 'disabled' : ''}>
          <span class="label">Agent ${pad(i + 1)}</span>
          <span class="fname">${esc(p.name)}</span>
          ${p.seen ? '<span class="mini-stamp c-white">Vu</span>' : ''}
        </button>`).join('')}
    </div>
    <div class="grow"></div>
    <button class="btn" data-action="beginRounds" ${seen === g.players.length ? '' : 'disabled'}>Commencer</button>
    <button class="link center" data-action="quit">Abandonner la partie</button>
  `;
}

function game() {
  const g = state.game;
  return `
    <div class="screen-head"><h2 class="display">Tour ${pad(g.round)}</h2>
      <button class="link" data-action="openPeek">Revoir mon mot</button></div>
    ${timerBlock()}
    <div class="speaker">
      <span class="label">Premier à parler</span>
      <span class="who">${esc(g.starter)}</span>
      <span class="muted">Chacun donne un indice sur son mot, puis votez.</span>
    </div>
    <div class="section-head"><span class="label">Touchez l'agent éliminé par le vote</span></div>
    <div class="files">
      ${g.players.map((p, i) => p.alive
        ? `<button class="file" data-action="askEliminate" data-name="${esc(p.name)}">
             <span class="label">Agent ${pad(i + 1)}</span><span class="fname">${esc(p.name)}</span></button>`
        : `<div class="file dead">
             <span class="label">Éliminé</span><span class="fname">${esc(p.name)}</span>
             <span class="mini-stamp ${roleClass(p.role)}">${ROLE_LABEL[p.role]}</span></div>`).join('')}
    </div>
    <div class="grow"></div>
    <button class="link center" data-action="quit">Abandonner la partie</button>
  `;
}

function timerBlock() {
  const t = state.game.timer;
  if (!t) return '';
  if (t.done) {
    return `
      <div class="timer done">
        <div class="timer-row"><span class="label">Temps écoulé</span><span class="clock">00:00</span></div>
        <div class="timer-row"><span class="stamp-inline">Place au vote</span>
          <button class="link" data-action="timerRestart">Relancer</button></div>
      </div>`;
  }
  const left = timeLeft(t);
  const paused = !t.endsAt;
  return `
    <div class="timer ${paused ? 'paused' : ''}">
      <div class="timer-row"><span class="label">${paused ? 'En pause' : 'Discussion'}</span><span class="clock" data-clock>${fmt(left)}</span></div>
      <div class="bar"><span data-bar style="transform:scaleX(${left / t.total})"></span></div>
      <div class="timer-row">
        <button class="link" data-action="timerToggle">${paused ? 'Reprendre' : 'Pause'}</button>
        <button class="link" data-action="timerRestart">Relancer</button>
      </div>
    </div>`;
}

function verdict(label, who, stampText, role) {
  return `
    <div class="verdict">
      <span class="label">${label}</span>
      ${who ? `<div class="who">${who}</div>` : ''}
      <span class="stamp ${roleClass(role)}">${stampText}</span>
    </div>`;
}

function reveal() {
  const g = state.game;
  const p = g.players.find((x) => x.name === g.eliminated);
  return `
    ${verdict('Agent éliminé', esc(p.name), ROLE_LABEL[p.role], p.role)}
    ${g.whiteGuess ? `<p class="center muted">A proposé « ${esc(g.whiteGuess)} » : raté.</p>` : ''}
    <button class="btn" data-action="continue">Continuer</button>
  `;
}

function whiteGuess() {
  const g = state.game;
  return `
    ${verdict('Agent éliminé', esc(g.eliminated), 'Mr. White', 'white')}
    <p>Dernière chance : s'il devine le mot des civils, Mr. White gagne la partie.</p>
    <form class="form-card" data-form="whiteGuess">
      <label class="field"><span class="label">Le mot des civils</span>
        <input type="text" name="guess" autocomplete="off" autofocus></label>
      <button class="btn" type="submit">Valider</button>
    </form>
    ${g.whiteGuess ? `
      <div class="speaker">
        <p>« ${esc(g.whiteGuess)} » n'est pas exactement le mot. Le mot était <strong>${esc(g.civilWord)}</strong>.</p>
        <p class="muted">Faute de frappe ou synonyme : le groupe accepte ?</p>
        <div class="row2">
          <button class="btn outline" data-action="whiteAccept">Accepter</button>
          <button class="btn red" data-action="whiteReject">Refuser</button>
        </div>
      </div>` : ''}
  `;
}

function end() {
  const g = state.game;
  const w = g.winner;
  const cls = w.includes('civil') ? 'civil' : w.includes('under') ? 'under' : 'white';
  const stampText = w.includes('civil') ? 'Les civils'
    : w.length === 2 ? 'Les imposteurs'
    : w.includes('under') ? 'Undercover' : 'Mr. White';
  return `
    ${verdict('Affaire classée · victoire', '', stampText, cls)}
    <div class="words">
      <div><span class="label c-civil">Mot des civils</span><span class="w">${esc(g.civilWord)}</span></div>
      <div><span class="label c-under">Mot undercover</span><span class="w">${esc(g.underWord)}</span></div>
    </div>
    <div class="table">
      ${g.players.map((p) => `
        <div class="tr">
          <span class="strong ${p.alive ? '' : 'dead'}">${esc(p.name)}</span>
          <span class="mini-stamp ${roleClass(p.role)}">${ROLE_LABEL[p.role]}</span>
          <span class="pts" style="min-width:44px;text-align:right">${w.includes(p.role) ? `+${POINTS[p.role]}` : ''}</span>
        </div>`).join('')}
    </div>
    <button class="btn" data-action="replay">Rejouer</button>
    <div class="links">
      <button class="link" data-action="toHome">Menu</button>
      <button class="link" data-action="go" data-screen="scores">Scores</button>
    </div>
  `;
}

function overlay() {
  if (!ui.overlay) return '';
  const g = state.game;
  if (ui.overlay.type === 'confirm') {
    return `<div class="overlay"><div class="sheet" role="dialog" aria-modal="true">
      <h3>${esc(ui.overlay.text)}</h3>
      <div class="row2">
        <button class="btn outline" data-action="closeOverlay">Annuler</button>
        <button class="btn red" data-action="confirmOverlay">Confirmer</button>
      </div></div></div>`;
  }
  if (ui.overlay.type === 'peek') {
    if (ui.peek !== null) {
      return `<div class="overlay"><div class="sheet" role="dialog" aria-modal="true" style="min-height:70vh">
        ${wordCard(g.players[ui.peek], ui.peek)}
        <button class="btn" data-action="closeOverlay">Fermer le dossier</button></div></div>`;
    }
    return `<div class="overlay"><div class="sheet" role="dialog" aria-modal="true">
      <h3>Qui veut revoir son mot ?</h3>
      <div class="files">${g.players.map((p, i) => p.alive
        ? `<button class="file" data-action="peek" data-i="${i}"><span class="label">Agent ${pad(i + 1)}</span><span class="fname">${esc(p.name)}</span></button>` : '').join('')}</div>
      <button class="link center" data-action="closeOverlay">Annuler</button></div></div>`;
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
    const i = state.disabledCats.indexOf(d.cat);
    if (i >= 0) state.disabledCats.splice(i, 1); else state.disabledCats.push(d.cat);
  },
  toggleAllCats: () => {
    state.disabledCats = state.disabledCats.length ? [] : Object.keys(allCategories());
  },
  removePair: (d) => {
    const p = allPairs().find((x) => x.id === d.id);
    if (!p) return;
    if (p.pending) {
      state.pendingPairs = state.pendingPairs.filter((x) => x.id !== p.id);
    } else if (cloudStatus !== 'online') {
      toast('Il faut être connecté pour supprimer une paire.');
    } else {
      confirm(`Supprimer « ${p.a} / ${p.b} » pour tout le monde ?`, () => window.cloud.remove(p.id));
    }
  },
  resetScores: () => confirm('Remettre tous les scores à zéro ?', () => { state.scores = {}; }),
  start: () => { if (canStart()) startGame(); },
  showWord: (d) => { state.game.dealIndex = +d.i; },
  hideWord: () => { const g = state.game; g.players[g.dealIndex].seen = true; g.dealIndex = null; },
  beginRounds: () => { pickStarter(); startTimer(); state.screen = 'game'; },
  setTimer: (d) => { state.timer = +d.v; },
  timerToggle: () => {
    const t = state.game.timer;
    if (t.endsAt) { t.left = t.endsAt - Date.now(); t.endsAt = null; } else { t.endsAt = Date.now() + t.left; t.left = null; }
  },
  timerRestart: () => startTimer(),
  toggleAdd: () => { ui.addOpen = !ui.addOpen; },
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
    if (state.players.some((p) => p.toLowerCase() === name.toLowerCase())) { toast('Ce nom est déjà pris.'); return false; }
    state.players.push(name);
  },
  addPair: (f) => {
    const a = f.elements.a.value.trim(), b = f.elements.b.value.trim();
    let cat = f.elements.cat.value === NEW_CAT ? f.elements.newCat.value.trim() : f.elements.cat.value;
    if (!a || !b) return false;
    if (!cat) { toast('Choisis ou crée une catégorie.'); return false; }
    if (normalize(a) === normalize(b)) { toast('Les deux mots doivent être différents.'); return false; }
    if (pairExists(a, b)) { toast('Cette paire existe déjà.'); return false; }
    // Réutilise une catégorie existante écrite différemment (accents, majuscules).
    cat = Object.keys(allCategories()).find((c) => normalize(c) === normalize(cat)) || cat;
    const pair = { id: newId(), a, b, cat };
    state.pendingPairs.push(pair);
    state.lastCat = cat;
    f.elements.a.value = f.elements.b.value = f.elements.newCat.value = '';
    f.elements.cat.value = cat;
    if (cloudStatus === 'online') sendPair(pair);
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
  unlockAudio();
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

// Recherche : on ne redessine que la liste pour garder le clavier ouvert.
app.addEventListener('input', (e) => {
  if (e.target.name !== 'q') return;
  ui.search = e.target.value;
  const list = app.querySelector('#pair-list');
  if (list) list.innerHTML = pairsList();
});

app.addEventListener('change', (e) => {
  if (e.target.name === 'cat') {
    syncNewCat();
    if (e.target.value === NEW_CAT) app.querySelector('input[name="newCat"]').focus();
  }
});

// Sécurité : on ne rouvre jamais l'app sur un mot affiché.
if (state.game) state.game.dealIndex = null;
render();
