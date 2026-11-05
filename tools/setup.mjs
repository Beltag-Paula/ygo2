// npm run setup — fetches the two data repos the rules engine needs (card scripts + card database).
import { execSync } from 'node:child_process'; import fs from 'node:fs';
for (const [dir, url] of [['CardScripts', 'https://github.com/ProjectIgnis/CardScripts'], ['BabelCDB', 'https://github.com/ProjectIgnis/BabelCDB']]) {
  if (fs.existsSync(dir)) { console.log(dir + ' already present — pulling'); execSync('git -C ' + dir + ' pull --ff-only', { stdio: 'inherit' }); }
  else execSync(`git clone --depth 1 ${url} ${dir}`, { stdio: 'inherit' });
}
console.log('\nDone. Start the game with: npm start');
