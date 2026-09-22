import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync('questions.json', 'utf8'));
const qChars = new Set();
const allChars = new Set();

for (const q of data.questions) {
  for (const ch of q.question) {
    if (/[\u4e00-\u9fff]/.test(ch)) qChars.add(ch);
  }
  for (const t of [q.question, ...(q.options || []), q.explanation]) {
    if (!t) continue;
    for (const ch of t) {
      if (/[\u4e00-\u9fff]/.test(ch)) allChars.add(ch);
    }
  }
}

console.log('Unique Chinese chars in q.question:', qChars.size);
console.log('Characters in q.question:', Array.from(qChars).join(''));
console.log('Total unique Chinese chars in questions.json:', allChars.size);
