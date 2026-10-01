// Vérifie words.js : chaque paire contient deux mots non vides, différents, sans doublon.
const fs = require('fs');
const src = fs.readFileSync(`${__dirname}/../words.js`, 'utf8');
const cats = new Function(`${src}; return WORD_CATEGORIES;`)();

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const seen = new Map();
const errors = [];
let total = 0;

for (const [cat, pairs] of Object.entries(cats)) {
  for (const pair of pairs) {
    total++;
    const [a, b] = pair;
    if (pair.length !== 2 || typeof a !== 'string' || typeof b !== 'string' || !a.trim() || !b.trim()) {
      errors.push(`${cat} : paire invalide ${JSON.stringify(pair)}`);
      continue;
    }
    if (norm(a) === norm(b)) errors.push(`${cat} : mots identiques « ${a} »`);
    const key = [norm(a), norm(b)].sort().join('|');
    if (seen.has(key)) errors.push(`${cat} : « ${a} / ${b} » déjà présente dans ${seen.get(key)}`);
    else seen.set(key, cat);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`${total} paires OK dans ${Object.keys(cats).length} catégories`);
