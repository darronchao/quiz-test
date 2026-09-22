import fs from 'node:fs';

async function main() {
  const csv = await (await fetch('https://raw.githubusercontent.com/ponlawat-w/hz-bpmf/master/hz-bpmf.csv')).text();
  const rawMap = {};
  for (const line of csv.split('\n')) {
    const [ch, zy] = line.trim().split(';');
    if (ch && zy && !rawMap[ch]) rawMap[ch] = zy;
  }

  const q = JSON.parse(fs.readFileSync('questions.json', 'utf8')).questions;
  const chars = new Set();
  for (const item of q) {
    for (const t of [item.question, ...(item.options || []), item.explanation]) {
      if (!t) continue;
      for (const c of t) {
        if (/[\u4e00-\u9fff]/.test(c)) chars.add(c);
      }
    }
  }

  // Common Taiwanese colloquial / grammatical pronunciations
  const overrides = {
    '的': '˙ㄉㄜ',
    '麼': '˙ㄇㄜ',
    '思': 'ㄙ˙',
    '數': 'ㄕㄨˋ',
    '了': '˙ㄌㄜ',
    '子': '˙ㄗ',
    '得': '˙ㄉㄜ',
    '們': '˙ㄇㄣ',
    '隻': 'ㄓ',
    '為': 'ㄨㄟˊ',
    '何': 'ㄏㄜˊ',
    '處': 'ㄔㄨˋ'
  };

  const finalDict = {};
  for (const c of Array.from(chars).sort()) {
    finalDict[c] = overrides[c] || rawMap[c] || '';
  }

  console.log('Final dictionary entries:', Object.keys(finalDict).length);
  fs.writeFileSync('tools/full_zhuyin_dict.json', JSON.stringify(finalDict, null, 2), 'utf8');
}

main();
