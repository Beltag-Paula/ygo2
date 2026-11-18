// npm run setup — fetches the two data repos the rules engine needs (card scripts + card database).
import { execSync } from 'node:child_process'; import fs from 'node:fs';
for (const [dir, url] of [['CardScripts', 'https://github.com/ProjectIgnis/CardScripts'], ['BabelCDB', 'https://github.com/ProjectIgnis/BabelCDB']]) {
  if (fs.existsSync(dir)) { console.log(dir + ' already present — pulling'); execSync('git -C ' + dir + ' pull --ff-only', { stdio: 'inherit' }); }
  else execSync(`git clone --depth 1 ${url} ${dir}`, { stdio: 'inherit' });
}
console.log('\nEngine data ready.');
// Optional: the photo scanner (Python). Skipped quietly if Python is missing/too new; the rest of the game does not need it.
try {
  const v = execSync("python3 -c \"import sys; print('%d.%d' % sys.version_info[:2])\"").toString().trim(), [maj, min] = v.split('.').map(Number);
  if (maj !== 3 || min < 9 || min > 12) throw new Error(`Python ${v} found, but the OCR library supports Python 3.9-3.12 only (no wheels for 3.13+). See ocr/README.md ("Python version").`);
  execSync('python3 -m pip install -q -r ocr/requirements.txt', { stdio: 'inherit' }); console.log('Photo scanner installed.');
} catch (e) { console.log('Photo scanner NOT installed: ' + (String(e.message).split('\n')[0]) + '\nThe game itself works without it. Details: ocr/README.md'); }
console.log('\nStart the game with: npm start');
