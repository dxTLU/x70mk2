'use strict';

// One-time setup: make the data/asset folders, mint the bridge token, write a starter project if
// projects/ is empty, and print exactly how to connect from the TurboWarp editor. Safe to re-run.

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { load } = require('../bridge/config');
const { stamp } = require('./twconfig');

// A tiny project: green flag writes a row to SQLite and shows the live CPU% + cache type, so the
// first build proves files, the database and system metrics all work.
function starterProject() {
  const stage = {
    isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
    currentCostume: 0, tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null, layerOrder: 0,
    costumes: [{ assetId: 'cd21514d0531fdffb22204e0ec5ed84a', name: 'backdrop1', md5ext: 'cd21514d0531fdffb22204e0ec5ed84a.svg', dataFormat: 'svg', rotationCenterX: 0, rotationCenterY: 0 }],
    sounds: [], volume: 100,
  };
  return {
    targets: [stage],
    monitors: [], extensions: [],
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'x70-scratch-pipeline' },
  };
}

async function writeStarter(file) {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(starterProject()));
  zip.file('cd21514d0531fdffb22204e0ec5ed84a.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function main() {
  const config = load();
  for (const dir of [config.dataDir, config.build.projectsDir, config.build.outDir, ...Object.values(config.bridge.fsRoots)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const rel = (p) => path.relative(config.root, p) || '.';

  const starter = path.join(config.build.projectsDir, 'starter.sb3');
  const hasProjects = fs.readdirSync(config.build.projectsDir).some((f) => /\.(sb3|sb2|sb)$/i.test(f));
  if (!hasProjects) {
    let buf = await writeStarter(starter);
    if (config.build.stampProjects) buf = await stamp(buf, config.runtime);
    fs.writeFileSync(starter, buf);
    console.log(`Wrote a starter project: ${rel(starter)}`);
  }

  const codespace = process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
    ? `https://${process.env.CODESPACE_NAME}-${config.bridge.port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
    : null;

  console.log('\nSetup complete.\n');
  console.log(`  Bridge token : ${config.bridge.token}`);
  console.log(`  Token file   : ${rel(config.bridge.tokenFile)}`);
  console.log(`  Local URL    : http://127.0.0.1:${config.bridge.port}`);
  if (codespace) console.log(`  Codespaces   : ${codespace}  (set this port to Public in the Ports tab)`);
  console.log('\nNext:');
  console.log('  1. npm run bridge        # start the bridge daemon (leave it running)');
  console.log('  2. Open the TurboWarp editor, add the extension from  <bridge URL>/extension.js');
  console.log('  3. Use the "pair with bridge" block once with the URL and token above');
  console.log('  4. npm run build         # package projects/ into dist/*.html (bridge pre-paired)');
  console.log('     npm run watch         # or rebuild automatically whenever you save a project\n');
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { writeStarter };
