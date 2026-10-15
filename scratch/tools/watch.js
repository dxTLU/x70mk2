'use strict';

// Watch projects/ and rebuild a project a moment after it is saved. This is the "save and it
// packages itself" step: drop an .sb3 in projects/ (TurboWarp editor: File -> Save to your
// computer, into that folder) and dist/<name>.html updates on its own.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { load } = require('../bridge/config');

function main() {
  const config = load();
  const dir = config.build.projectsDir;
  fs.mkdirSync(dir, { recursive: true });
  const targetFlag = process.argv.find((a) => a.startsWith('--target='));
  const debounce = config.build.watchDebounceMs;
  const timers = new Map();
  let building = false;
  const queue = new Set();

  const runBuild = (file) => {
    if (building) { queue.add(file); return; }
    building = true;
    const args = ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'build.js'), file];
    if (targetFlag) args.push(targetFlag);
    const started = Date.now();
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('close', () => {
      building = false;
      console.log(`[watch] done in ${((Date.now() - started) / 1000).toFixed(1)}s — waiting for the next save\n`);
      const next = queue.values().next().value;
      if (next) { queue.delete(next); runBuild(next); }
    });
  };

  const schedule = (file) => {
    clearTimeout(timers.get(file));
    timers.set(file, setTimeout(() => { timers.delete(file); runBuild(file); }, debounce));
  };

  console.log(`[watch] watching ${dir} for .sb3 / .sb2 saves (Ctrl+C to stop)`);
  fs.watch(dir, (event, filename) => {
    if (!filename || !/\.(sb3|sb2|sb)$/i.test(filename)) return;
    const full = path.join(dir, filename);
    // fs.watch fires mid-write; the debounce lets the file finish before we read it.
    fs.stat(full, (err, st) => { if (!err && st.isFile() && st.size > 0) schedule(full); });
  });
}

if (require.main === module) main();
