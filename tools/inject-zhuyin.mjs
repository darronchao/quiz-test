import fs from 'node:fs';

const dict = JSON.parse(fs.readFileSync('tools/full_zhuyin_dict.json', 'utf8'));
let app = fs.readFileSync('app.js', 'utf8');

const dictJson = JSON.stringify(dict);
const dictCode = `const ZHUYIN_DICT = ${dictJson};`;

// Replace const ZHUYIN_DICT = { ... };
const re = /const ZHUYIN_DICT = \{[\s\S]*?\};/;
if (!re.test(app)) {
  console.error('Could not find ZHUYIN_DICT in app.js');
  process.exit(1);
}

app = app.replace(re, dictCode);
fs.writeFileSync('app.js', app, 'utf8');
console.log('Successfully injected 728-character ZHUYIN_DICT into app.js!');
