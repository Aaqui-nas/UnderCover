const STORAGE_KEY = 'undercover-v1';
const PAIRS_KEY = 'undercover-pairs';
const PHOTOS_KEY = 'undercover-photos'; // ancienne version : photos gardées sur le téléphone
const AGENTS_KEY = 'undercover-agents';
const STAT_FIELDS = ['points', 'games', 'wins', 'civilG', 'civilW', 'underG', 'underW', 'whiteG', 'whiteW', 'firstOut', 'survived', 'guessed'];
const BANNED_SCORE = -3; // note nette à partir de laquelle une paire n'est plus tirée
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
  agentOps: [], // modifications d'agents faites hors-ligne, envoyées au retour du réseau
  rated: {}, // paires déjà notées sur ce téléphone : id → +1 / -1
  pendingRatings: [], // notes données hors-ligne
  usedPairs: [],
  timer: 120, // durée de discussion par tour, en secondes (0 = sans chrono)
  screen: 'home',
  game: null,
  ...state,
};
if (state.screen === 'custom' || state.screen === 'trash') state.screen = 'pairs';
if (state.screen === 'profile') state.screen = 'agents';
// Ancienne version : paires gardées seulement sur le téléphone → à envoyer dans la base.
if (state.customPairs) {
  for (const [a, b] of state.customPairs) state.pendingPairs.push({ id: newId(), a, b, cat: 'Mots perso' });
  delete state.customPairs;
}
delete state.categories;
let ui = { overlay: null, peek: null, search: '', addOpen: false, profile: null, trash: null };

// Agents (joueurs) : nom, photo, points et stats sont dans la base, partagés entre
// téléphones. Copie locale pour jouer sans réseau.
let agentsCache = { agents: [], syncedAt: 0 };
try { agentsCache = JSON.parse(localStorage.getItem(AGENTS_KEY)) || agentsCache; } catch {}
let agentsLoaded = false; // liste reçue du serveur pendant cette session

window.onAgents = (agents) => {
  agentsCache = { agents, syncedAt: Date.now() };
  agentsLoaded = true;
  try { localStorage.setItem(AGENTS_KEY, JSON.stringify(agentsCache)); } catch {}
  migrateLocalAgents();
  if (['home', 'agents', 'profile'].includes(state.screen)) render(); else save();
};

// Vue des agents = base + modifications encore en attente sur ce téléphone.
function allAgents() {
  const map = new Map(agentsCache.agents.map((a) => [a.id, { ...a }]));
  for (const op of state.agentOps) {
    if (op.type === 'delete') map.delete(op.id);
    else if (op.type === 'set') map.set(op.id, { ...(map.get(op.id) || { id: op.id }), ...op.data });
    else if (op.type === 'inc' && map.has(op.id)) {
      const a = map.get(op.id);
      for (const [k, v] of Object.entries(op.data)) a[k] = (a[k] || 0) + v;
    }
  }
  return [...map.values()].filter((a) => a.name);
}
const nameKey = (name) => normalize(name.trim());
const agentByName = (name) => allAgents().find((a) => nameKey(a.name) === nameKey(name));
const agentById = (id) => allAgents().find((a) => a.id === id);

function agentOp(op) {
  if (cloudStatus === 'online' && window.cloud) runAgentOp(op);
  else state.agentOps.push(op);
}

function runAgentOp(op) {
  const c = window.cloud;
  const write = op.type === 'set' ? c.agentSet(op.id, op.data)
    : op.type === 'inc' ? c.agentInc(op.id, op.data)
    : c.agentDelete(op.id);
  write.catch((err) => {
    console.error(err);
    toast('Modification d\'un agent refusée par le serveur.');
  });
}

function flushAgentOps() {
  const queue = state.agentOps;
  state.agentOps = [];
  queue.forEach(runAgentOp);
}

// Retrouve l'agent de ce nom, ou le crée.
function ensureAgent(name) {
  const existing = agentByName(name);
  if (existing) return existing;
  const id = newId();
  agentOp({ type: 'set', id, data: { name: name.trim().slice(0, 20), createdAt: true } });
  return { id, name };
}

// Ancienne version : points, stats et photos étaient sur le téléphone → on les verse dans la base.
function migrateLocalAgents() {
  if (state.agentsMigrated || !agentsLoaded || cloudStatus !== 'online') return;
  state.agentsMigrated = true;
  let oldPhotos = {};
  try { oldPhotos = JSON.parse(localStorage.getItem(PHOTOS_KEY)) || {}; } catch {}
  const scores = state.scores || {}, stats = state.stats || {};
  const names = new Set([...state.players, ...Object.keys(scores), ...Object.keys(stats), ...Object.keys(oldPhotos)]);
  for (const name of names) {
    const a = ensureAgent(name);
    const st = stats[name];
    const delta = { points: scores[name] || 0 };
    if (st) {
      Object.assign(delta, {
        games: st.games, wins: st.wins, civilG: st.civil[0], civilW: st.civil[1], underG: st.under[0], underW: st.under[1],
        whiteG: st.white[0], whiteW: st.white[1], firstOut: st.firstOut, survived: st.survived, guessed: st.guessed,
      });
    }
    if (Object.values(delta).some(Boolean)) agentOp({ type: 'inc', id: a.id, data: delta });
    if (oldPhotos[name] && !a.photo) agentOp({ type: 'set', id: a.id, data: { photo: oldPhotos[name] } });
  }
  delete state.scores;
  delete state.stats;
  try { localStorage.removeItem(PHOTOS_KEY); } catch {}
  save();
}

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
  if (status === 'online') { flushPending(); flushRatings(); flushAgentOps(); migrateLocalAgents(); }
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

function flushRatings() {
  const queue = state.pendingRatings;
  state.pendingRatings = [];
  for (const r of queue) {
    window.cloud.rate(r.id, r.v).catch((err) => {
      // Paire supprimée entre-temps : on oublie la note ; sinon on réessaiera.
      if (err?.code !== 'not-found' && err?.code !== 'permission-denied') state.pendingRatings.push(r);
      save();
    });
  }
}

function ratePair(id, v) {
  if (!id || state.rated[id]) return;
  state.rated[id] = v;
  if (cloudStatus === 'online') {
    window.cloud.rate(id, v).catch(() => state.pendingRatings.push({ id, v }));
  } else {
    state.pendingRatings.push({ id, v });
  }
}

const netScore = (p) => (p.up || 0) - (p.down || 0);

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
  for (const p of allPairs()) (cats[p.cat || DEFAULT_CAT] ||= []).push(p);
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
  return Object.keys(cats).filter((c) => !state.disabledCats.includes(c)).flatMap((c) => cats[c])
    .filter((p) => netScore(p) > BANNED_SCORE);
}

// Tirage pondéré par les notes : une paire appréciée sort plus souvent.
function weightedPick(pairs) {
  const weight = (p) => Math.min(3, Math.max(0.25, 1 + 0.25 * netScore(p)));
  let r = Math.random() * pairs.reduce((sum, p) => sum + weight(p), 0);
  for (const p of pairs) if ((r -= weight(p)) <= 0) return p;
  return pairs[pairs.length - 1];
}

function choosePair() {
  const pool = pairPool();
  const key = (p) => `${p.a}|${p.b}`;
  let fresh = pool.filter((p) => !state.usedPairs.includes(key(p)));
  if (!fresh.length) {
    const poolKeys = new Set(pool.map(key));
    state.usedPairs = state.usedPairs.filter((k) => !poolKeys.has(k));
    fresh = pool;
  }
  const pair = weightedPick(fresh);
  state.usedPairs.push(key(pair));
  if (state.usedPairs.length > 1500) state.usedPairs = state.usedPairs.slice(-1500);
  return { pair, words: Math.random() < 0.5 ? [pair.a, pair.b] : [pair.b, pair.a] };
}

// ---------- Game logic ----------

function startGame() {
  const { pair, words: [civilWord, underWord] } = choosePair();
  const roles = shuffle([
    ...Array(state.undercover).fill('under'),
    ...Array(state.white).fill('white'),
    ...Array(limits().civil).fill('civil'),
  ]);
  state.game = {
    pairId: pair.pending ? null : pair.id,
    civilWord,
    underWord,
    elimOrder: [],
    whiteGuessed: false,
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

const statsOf = (a) => Object.fromEntries(STAT_FIELDS.map((f) => [f, a?.[f] || 0]));

function endGame(winnerRoles) {
  const g = state.game;
  g.winner = winnerRoles;
  for (const p of g.players) {
    const won = winnerRoles.includes(p.role);
    agentOp({ type: 'inc', id: ensureAgent(p.name).id, data: {
      games: 1,
      wins: won ? 1 : 0,
      points: won ? POINTS[p.role] : 0,
      [`${p.role}G`]: 1,
      [`${p.role}W`]: won ? 1 : 0,
      survived: p.alive ? 1 : 0,
      firstOut: g.elimOrder[0] === p.name ? 1 : 0,
      guessed: p.role === 'white' && g.whiteGuessed && g.eliminated === p.name ? 1 : 0,
    } });
  }
  state.screen = 'end';
}

function eliminate(name) {
  const g = state.game;
  const p = g.players.find((x) => x.name === name);
  p.alive = false;
  g.eliminated = name;
  (g.elimOrder ||= []).push(name);
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
const backLink = (screen = 'home', label = 'Retour') => `<button class="link back" data-action="go" data-screen="${screen}">${icon('back')} ${label}</button>`;
const APP_URL = new URL('./', location.href).href;

function initials(name) {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

function avatar(name, cls = '') {
  const src = agentByName(name)?.photo;
  return src
    ? `<img class="ava ${cls}" src="${src}" alt="">`
    : `<span class="ava initials ${cls}" aria-hidden="true">${esc(initials(name))}</span>`;
}

const percent = (won, played) => (played ? `${Math.round((100 * won) / played)} %` : '–');

function render() {
  const screens = { home, pairs: pairsScreen, trash, agents, scores: agents, profile, deal, game, whiteGuess, reveal, end };
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
  const inGame = new Set(state.players.map(nameKey));
  const known = allAgents().filter((a) => !inGame.has(nameKey(a.name)))
    .sort((x, y) => (y.games || 0) - (x.games || 0) || collator.compare(x.name, y.name));

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
      ${known.length ? `<div class="known">
        <span class="label">Déjà venus</span>
        <div class="known-list">${known.map((a) => `
          <button class="known-agent" data-action="addKnown" data-name="${esc(a.name)}">${avatar(a.name, 'xs')}<span>${esc(a.name)}</span></button>`).join('')}
        </div></div>` : ''}
      ${n ? `<ol class="roster">
        ${state.players.map((p, i) => `
          <li>
            <span class="n">${pad(i + 1)}</span>
            <button class="who-btn" data-action="openProfile" data-name="${esc(p)}" aria-label="Fiche de ${esc(p)}">
              ${avatar(p, 'sm')}<span class="name">${esc(p)}</span></button>
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
      <button class="link" data-action="go" data-screen="pairs">Les paires</button>
      <button class="link" data-action="go" data-screen="agents">Agents</button>
      <button class="link" data-action="openInvite">Inviter</button>
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
    <div class="screen-head"><h2 class="display">Les paires</h2>
      <button class="link" data-action="openTrash">Corbeille</button></div>
    <p class="muted">${allPairs().length} paires. ${online
      ? 'Ajouts et suppressions sont visibles par tout le monde.'
      : 'Hors ligne : tu peux ajouter des paires (envoyées au retour d\'internet), mais pas en supprimer.'}
      Les paires notées ${BANNED_SCORE} ou moins ne sont plus tirées.</p>
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
            ${netScore(p) <= BANNED_SCORE ? '<span class="mini-stamp c-under">Écartée</span>' : ''}
            ${p.up || p.down ? `<span class="score ${netScore(p) > 0 ? 'pos' : netScore(p) < 0 ? 'neg' : ''}" title="${p.up || 0} pour, ${p.down || 0} contre">${netScore(p) > 0 ? '+' : ''}${netScore(p)}</span>` : ''}
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

function trash() {
  let content;
  if (ui.trash === 'offline') content = '<p class="empty">Il faut internet pour voir la corbeille.</p>';
  else if (ui.trash === 'error') content = '<p class="empty">Impossible de charger la corbeille.</p>';
  else if (!ui.trash) content = '<p class="empty">Chargement…</p>';
  else if (!ui.trash.length) content = '<p class="empty">La corbeille est vide.</p>';
  else {
    content = `<div class="table">
      ${ui.trash.map((t) => {
        const d = new Date(t.deletedAt);
        return `
          <div class="tr">
            <div><div class="strong">${esc(t.a)} <span class="slash">/</span> ${esc(t.b)}</div>
              <div class="sub">${esc(t.cat)} · supprimée le ${d.toLocaleDateString('fr-FR')} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</div></div>
            <button class="link" data-action="restore" data-id="${esc(t.id)}">Restaurer</button>
          </div>`;
      }).join('')}
    </div>`;
  }
  return `
    ${backLink('pairs', 'Les paires')}
    <div class="screen-head"><h2 class="display">Corbeille</h2></div>
    <p class="muted">Les 100 dernières paires supprimées. « Restaurer » la remet dans la base pour tout le monde, avec ses notes.</p>
    ${content}
  `;
}

function loadTrash() {
  if (cloudStatus !== 'online') { ui.trash = 'offline'; return; }
  ui.trash = null;
  window.cloud.listTrash()
    .then((list) => { ui.trash = list; })
    .catch(() => { ui.trash = 'error'; })
    .finally(() => { if (state.screen === 'trash') render(); });
}

function agents() {
  const rows = allAgents().sort((x, y) => (y.points || 0) - (x.points || 0) || (y.wins || 0) - (x.wins || 0) || collator.compare(x.name, y.name));
  return `
    ${backLink()}
    <div class="screen-head"><h2 class="display">Agents</h2></div>
    <p class="muted">Partagés entre tous les téléphones. Victoire : civil ${POINTS.civil} pts · Mr. White ${POINTS.white} pts · Undercover ${POINTS.under} pts.</p>
    ${rows.length ? `<div class="table">
      ${rows.map((a, i) => `
        <button class="tr agent-row" data-action="openProfile" data-id="${esc(a.id)}">
          <span class="rank">${pad(i + 1)}</span>
          ${avatar(a.name, 'sm')}
          <span class="fill"><span class="strong">${esc(a.name)}</span>
            <span class="sub">${a.wins || 0} victoire${a.wins > 1 ? 's' : ''} · ${a.games || 0} partie${a.games > 1 ? 's' : ''}</span></span>
          <span class="pts">${a.points || 0}</span>
        </button>`).join('')}
    </div>
    <button class="link red" data-action="resetPoints">Remettre les points de tous à zéro</button>`
    : '<p class="empty">Aucun agent pour l\'instant. Ajoute des joueurs sur l\'accueil.</p>'}
  `;
}

function profile() {
  const a = agentById(ui.profile);
  if (!a) return agents();
  const st = statsOf(a);
  const role = (key, label) => `
    <div class="tr">
      <span class="strong fill ${roleClass(key)}">${label}</span>
      <span class="sub">${st[`${key}W`]} / ${st[`${key}G`]} gagnée${st[`${key}W`] > 1 ? 's' : ''}</span>
      <span class="pts small">${percent(st[`${key}W`], st[`${key}G`])}</span>
    </div>`;
  return `
    ${backLink('agents', 'Agents')}
    <div class="id-card">
      <div class="id-photo">${avatar(a.name, 'xl')}</div>
      <div class="id-info">
        <span class="label">Fiche agent</span>
        <h2 class="display">${esc(a.name)}</h2>
        <button class="link" data-action="takePhoto" data-id="${esc(a.id)}">Prendre une photo</button>
        <button class="link" data-action="choosePhoto" data-id="${esc(a.id)}">Choisir dans la galerie</button>
        ${a.photo ? `<button class="link red" data-action="removePhoto" data-id="${esc(a.id)}">Retirer la photo</button>` : ''}
      </div>
    </div>
    <div class="stat-grid">
      <div><span class="big">${st.games}</span><span class="label">Parties</span></div>
      <div><span class="big">${st.wins}</span><span class="label">Victoires</span></div>
      <div><span class="big">${percent(st.wins, st.games)}</span><span class="label">Réussite</span></div>
      <div><span class="big">${st.points}</span><span class="label">Points</span></div>
    </div>
    <section class="section">
      <div class="section-head"><span class="label">Par rôle</span></div>
      <div class="table">${role('civil', 'Civil')}${role('under', 'Undercover')}${role('white', 'Mr. White')}</div>
    </section>
    <section class="section">
      <div class="section-head"><span class="label">Faits marquants</span></div>
      <div class="table">
        <div class="tr"><span class="fill">Éliminé en premier</span><span class="pts small">${st.firstOut}</span></div>
        <div class="tr"><span class="fill">Encore en jeu à la fin</span><span class="pts small">${st.survived}</span></div>
        <div class="tr"><span class="fill">Mot deviné en Mr. White</span><span class="pts small">${st.guessed}</span></div>
      </div>
    </section>
    <div class="links">
      ${st.games || st.points ? `<button class="link red" data-action="resetStats" data-id="${esc(a.id)}">Effacer ses stats</button>` : '<span></span>'}
      <button class="link red" data-action="deleteAgent" data-id="${esc(a.id)}">Supprimer l'agent</button>
    </div>
  `;
}

// Photo : recadrée en carré et réduite pour tenir dans le stockage du téléphone.
// Champ fichier placé hors de #app : quand l'appareil photo s'ouvre, l'appli passe en
// arrière-plan et se redessine au retour ; un champ dans #app serait détruit avant de
// recevoir la photo.
const photoInput = document.createElement('input');
photoInput.type = 'file';
photoInput.accept = 'image/*';
photoInput.hidden = true;
document.body.appendChild(photoInput);
let photoTarget = null;
photoInput.addEventListener('change', () => {
  const file = photoInput.files?.[0];
  if (file && photoTarget) setPhoto(photoTarget, file);
  photoInput.value = '';
});

function pickPhoto(id, camera) {
  photoTarget = id;
  if (camera) photoInput.setAttribute('capture', 'user'); else photoInput.removeAttribute('capture');
  photoInput.click();
}

function setPhoto(id, file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const size = 192, side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    URL.revokeObjectURL(url);
    agentOp({ type: 'set', id, data: { photo: canvas.toDataURL('image/jpeg', 0.8) } });
    render();
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast('Impossible de lire cette image.'); };
  img.src = url;
}

function wordCard(p, index) {
  return `
    <div class="dossier">
      <div class="top"><span class="label">Agent ${pad(index + 1)}</span><span class="label">Usage strictement personnel</span></div>
      <div class="who-row">${avatar(p.name, 'md')}<div class="who-big">${esc(p.name)}</div></div>
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
          ${avatar(p.name, 'file-ava')}
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
             ${avatar(p.name, 'file-ava')}
             <span class="label">Agent ${pad(i + 1)}</span><span class="fname">${esc(p.name)}</span></button>`
        : `<div class="file dead">
             ${avatar(p.name, 'file-ava')}
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

function verdict(label, who, stampText, role, face = '') {
  return `
    <div class="verdict">
      ${face}
      <span class="label">${label}</span>
      ${who ? `<div class="who">${who}</div>` : ''}
      <span class="stamp ${roleClass(role)}">${stampText}</span>
    </div>`;
}

function reveal() {
  const g = state.game;
  const p = g.players.find((x) => x.name === g.eliminated);
  return `
    ${verdict('Agent éliminé', esc(p.name), ROLE_LABEL[p.role], p.role, avatar(p.name, 'lg'))}
    ${g.whiteGuess ? `<p class="center muted">A proposé « ${esc(g.whiteGuess)} » : raté.</p>` : ''}
    <button class="btn" data-action="continue">Continuer</button>
  `;
}

function whiteGuess() {
  const g = state.game;
  return `
    ${verdict('Agent éliminé', esc(g.eliminated), 'Mr. White', 'white', avatar(g.eliminated, 'lg'))}
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
          <span class="fill agent-cell">${avatar(p.name, 'sm')}<span class="strong ${p.alive ? '' : 'dead'}">${esc(p.name)}</span></span>
          <span class="mini-stamp ${roleClass(p.role)}">${ROLE_LABEL[p.role]}</span>
          <span class="pts" style="min-width:44px;text-align:right">${w.includes(p.role) ? `+${POINTS[p.role]}` : ''}</span>
        </div>`).join('')}
    </div>
    ${g.pairId ? `
      <div class="rate">
        <span class="label">Cette paire était…</span>
        ${state.rated[g.pairId]
          ? `<p class="sub">Note enregistrée : ${state.rated[g.pairId] > 0 ? 'bonne paire' : 'paire nulle'}. Merci.</p>`
          : `<div class="row2">
              <button class="btn outline" data-action="rate" data-v="1">Bonne</button>
              <button class="btn outline" data-action="rate" data-v="-1">Nulle</button>
            </div>`}
      </div>` : ''}
    <button class="btn" data-action="replay">Rejouer</button>
    <div class="links">
      <button class="link" data-action="toHome">Menu</button>
      <button class="link" data-action="go" data-screen="agents">Agents</button>
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
  if (ui.overlay.type === 'invite') {
    return `<div class="overlay"><div class="sheet" role="dialog" aria-modal="true">
      <h3>Inviter un agent</h3>
      <div class="qr">${qrSvg(APP_URL)}</div>
      <p class="center sub url">${esc(APP_URL)}</p>
      <div class="row2">
        <button class="btn outline" data-action="copyLink">Copier</button>
        ${navigator.share ? '<button class="btn" data-action="shareLink">Partager</button>' : ''}
      </div>
      <p class="sub">iPhone : ouvrir dans Safari, Partager, « Sur l'écran d'accueil ».<br>Android : Chrome, menu, « Installer l'application ».</p>
      <button class="link center" data-action="closeOverlay">Fermer</button>
    </div></div>`;
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

function qrSvg(text) {
  if (typeof qrcode !== 'function') return '';
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
  return `<svg viewBox="-3 -3 ${n + 6} ${n + 6}" shape-rendering="crispEdges" role="img" aria-label="QR code du lien de l'appli">
    <rect x="-3" y="-3" width="${n + 6}" height="${n + 6}" fill="#f4eedf"/><path d="${d}" fill="#1d1b17"/></svg>`;
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
      confirm(`Supprimer « ${p.a} / ${p.b} » pour tout le monde ?`, () => window.cloud.remove(p));
    }
  },
  resetPoints: () => confirm('Remettre les points de tous les agents à zéro, pour tout le monde ?', () => {
    for (const a of allAgents()) if (a.points) agentOp({ type: 'set', id: a.id, data: { points: 0 } });
  }),
  openProfile: (d) => { ui.profile = d.id || ensureAgent(d.name).id; state.screen = 'profile'; },
  addKnown: (d) => { if (!state.players.some((p) => nameKey(p) === nameKey(d.name))) state.players.push(d.name); },
  takePhoto: (d) => pickPhoto(d.id, true),
  choosePhoto: (d) => pickPhoto(d.id, false),
  removePhoto: (d) => agentOp({ type: 'set', id: d.id, data: { photo: null } }),
  resetStats: (d) => confirm(`Effacer les stats et les points de ${agentById(d.id)?.name} pour tout le monde ?`, () => {
    agentOp({ type: 'set', id: d.id, data: Object.fromEntries(STAT_FIELDS.map((f) => [f, 0])) });
  }),
  deleteAgent: (d) => {
    const a = agentById(d.id);
    confirm(`Supprimer ${a?.name} et ses stats pour tout le monde ?`, () => {
      agentOp({ type: 'delete', id: d.id });
      state.players = state.players.filter((p) => nameKey(p) !== nameKey(a.name));
      state.screen = 'agents';
    });
  },
  rate: (d) => ratePair(state.game.pairId, +d.v),
  openTrash: () => { state.screen = 'trash'; loadTrash(); },
  restore: (d) => {
    const t = ui.trash.find((x) => x.id === d.id);
    if (!t) return;
    if (cloudStatus !== 'online') return toast('Il faut être connecté pour restaurer une paire.');
    if (pairExists(t.a, t.b)) return toast('Cette paire est déjà dans la base.');
    window.cloud.restore(t)
      .then(() => { ui.trash = ui.trash.filter((x) => x.id !== t.id); toast(`« ${t.a} / ${t.b} » restaurée.`); })
      .catch(() => toast('Restauration impossible.'))
      .finally(() => { if (state.screen === 'trash') render(); });
  },
  openInvite: () => { ui.overlay = { type: 'invite' }; },
  copyLink: () => {
    navigator.clipboard?.writeText(APP_URL).then(() => toast('Lien copié.'), () => toast(APP_URL));
  },
  shareLink: () => {
    navigator.share({ title: 'Undercover', text: 'Rejoins la partie d\'Undercover', url: APP_URL }).catch(() => {});
  },
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
  whiteAccept: () => { state.game.whiteGuessed = true; endGame(['white']); },
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
    if (state.players.some((p) => nameKey(p) === nameKey(name))) { toast('Cet agent est déjà dans la partie.'); return false; }
    // Un agent existant garde son orthographe ; sinon on le crée dans la base.
    state.players.push(ensureAgent(name).name);
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
    if (normalize(guess) === normalize(g.civilWord)) { g.whiteGuessed = true; return endGame(['white']); }
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
