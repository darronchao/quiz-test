import fs from 'node:fs';

const raw = JSON.parse(fs.readFileSync('tools/raw_geptkids.json', 'utf8'));

function cleanPunctuation(str) {
  if (!str) return '';
  let s = str.trim();
  // Commas
  s = s.replace(/([\u4e00-\u9fff])\s*,\s*/g, '$1，').replace(/,\s*([\u4e00-\u9fff])/g, '，$1');
  // Semicolons
  s = s.replace(/([\u4e00-\u9fff])\s*;\s*/g, '$1；').replace(/;\s*([\u4e00-\u9fff])/g, '；$1');
  // Colons
  s = s.replace(/([\u4e00-\u9fff])\s*:\s*/g, '$1：').replace(/:\s*([\u4e00-\u9fff])/g, '：$1');
  // Exclamation and Question marks
  s = s.replace(/([\u4e00-\u9fff])\s*!\s*/g, '$1！').replace(/!\s*([\u4e00-\u9fff])/g, '！$1');
  s = s.replace(/([\u4e00-\u9fff])\s*\?\s*/g, '$1？').replace(/\?\s*([\u4e00-\u9fff])/g, '？$1');

  // Parentheses enclosing Chinese
  s = s.replace(/\(([^()]*[\u4e00-\u9fff][^()]*)\)/g, '（$1）');
  // Full-width parentheses enclosing pure English/ASCII numbers
  s = s.replace(/（([ -~]*[A-Za-z0-9][ -~]*)）/g, '($1)');

  // In case of nested or missed
  s = s.replace(/\(([^()]*[\u4e00-\u9fff][^()]*)\)/g, '（$1）');

  // Double quotes
  s = s.replace(/"([^"]*)"/g, '「$1」');
  return s;
}

// Group words by category and POS for intelligent distractor selection
const byCategory = new Map();
const byPOS = new Map();

for (const item of raw) {
  const cat = item.category_C || '其他';
  const pos = item.POS || '其他';
  if (!byCategory.has(cat)) byCategory.set(cat, []);
  if (!byPOS.has(pos)) byPOS.set(pos, []);
  byCategory.get(cat).push(item);
  byPOS.get(pos).push(item);
}

// Deterministic PRNG for reproducible shuffle
function pseudoRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function() {
    return (s = (s * 16807) % 2147483647) / 2147483647;
  };
}

const questions = [];

for (let i = 0; i < raw.length; i++) {
  const item = raw[i];
  const voc = item.voc.trim();
  const correctChinese = cleanPunctuation(item.Chinese);
  const cat = item.category_C || '其他';
  const pos = item.POS ? cleanPunctuation(item.POS) : '單字';

  // Find distractors
  const distractors = new Set();
  const sameCat = (byCategory.get(cat) || []).filter(x => x.voc !== voc);
  const samePOS = (byPOS.get(item.POS) || []).filter(x => x.voc !== voc);
  const allOthers = raw.filter(x => x.voc !== voc);

  const rand = pseudoRandom(i * 31 + 17);

  function tryAdd(list) {
    // shuffle candidate indices
    const indices = Array.from({ length: list.length }, (_, k) => k);
    for (let j = indices.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [indices[j], indices[k]] = [indices[k], indices[j]];
    }
    for (const idx of indices) {
      if (distractors.size >= 3) break;
      const candidateChinese = cleanPunctuation(list[idx].Chinese);
      if (candidateChinese && candidateChinese !== correctChinese && !distractors.has(candidateChinese)) {
        distractors.add(candidateChinese);
      }
    }
  }

  tryAdd(sameCat);
  if (distractors.size < 3) tryAdd(samePOS);
  if (distractors.size < 3) tryAdd(allOthers);

  const distractorArr = Array.from(distractors).slice(0, 3);
  // Target answer index 0..3
  const ansIdx = i % 4;
  const options = [...distractorArr];
  options.splice(ansIdx, 0, correctChinese);

  const letters = ['A', 'B', 'C', 'D'];
  const ansLetter = letters[ansIdx];

  const qObj = {
    id: `gk-q${i + 1}`,
    level: '初級',
    round: 'GEPT Kids 核心單字',
    subject: '小學英檢核心單字',
    chapter: cat,
    topic: pos,
    question: `英文單字「${voc}」（${pos}）的中文意思是什麼？`,
    options: options,
    answer: ansIdx,
    explanation: `正解 (${ansLetter})。「${voc}」（${pos}）的中文意思為「${correctChinese}」。`
  };

  if (item.remarks) {
    const remarkClean = cleanPunctuation(item.remarks);
    qObj.explanation += ` 備註：${remarkClean}`;
  }

  questions.push(qObj);
}

const outputData = {
  meta: {
    title: 'elementary english 小學英檢單字測驗',
    note: '題目改編自 GEPT Kids 小學英檢官方推薦單字表（共 685 題），涵蓋常用主題與生活情境。',
    defaultTimeLimitMin: 60,
    guides: {
      '小學英檢核心單字': 'https://www.geptkids.org.tw/geptkids/wordlist/'
    }
  },
  questions: questions
};

fs.writeFileSync('questions.json', JSON.stringify(outputData, null, 2), 'utf8');
console.log(`Successfully generated ${questions.length} questions to questions.json`);
