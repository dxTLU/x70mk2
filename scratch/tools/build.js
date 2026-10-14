'use strict';

// Package every project in projects/ (or the files named on the command line) into standalone
// builds under dist/. Each project gets its runtime settings from pipeline.config.json and the
// x70 Bridge extension baked in and pre-paired with the local bridge, so the packaged game can
// use files, the cache, SQLite and live assets with no setup.
//
//   node tools/build.js                 # all projects, the configured targets
//   node tools/build.js game.sb3        # one project
//   node tools/build.js --target=html   # override the target(s)
//
// On a Chromebook / Codespaces the runnable target is "html": one self-contained file you open in
// the browser. The electron-* targets build a desktop app as a .zip artifact to download and run
// on a real Windows/Linux/Mac machine (they cannot run inside the container — there is no display).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { load } = require('../bridge/config');
const { packagerOptions } = require('./twconfig');

const RUNNABLE_HERE = new Set(['html', 'zip']);

function bakedExtension(extSource, pairing) {
  // The extension reads `const BAKED = null; // @x70-baked`; replace it with the real pairing so
  // the packaged project connects without the user running the "pair with bridge" block.
  const line = `const BAKED = ${JSON.stringify(pairing)}; // @x70-baked`;
  if (!extSource.includes('// @x70-baked')) throw new Error('Extension is missing the @x70-baked marker');
  return extSource.replace(/const BAKED = null; \/\/ @x70-baked/, line);
}

/** URL the packaged project should use to reach the bridge. Codespaces forwards the port publicly. */
function bridgeURL(config) {
  if (process.env.X70_BRIDGE_PUBLIC_URL) return process.env.X70_BRIDGE_PUBLIC_URL.replace(/\/$/, '');
  const port = config.bridge.port;
  if (process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    return `https://${process.env.CODESPACE_NAME}-${port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
  }
  return `http://127.0.0.1:${port}`;
}

async function buildOne(Packager, config, file, targets, extSource, pairing) {
  const name = path.basename(file).replace(/\.(sb3|sb2|sb)$/i, '');
  const data = await fsp.readFile(file);
  const loaded = await Packager.loadProject(new Uint8Array(data));
  const outputs = [];
  for (const target of targets) {
    const packager = new Packager.Packager();
    packager.project = loaded;
    packagerOptions(config)(packager);
    packager.options.target = target;
    packager.options.app.packageName = name;
    packager.options.app.windowTitle = name;
    packager.options.extensions = [`data:text/javascript;,${encodeURIComponent(bakedExtension(extSource, pairing))}`];
    packager.options.bakeExtensions = true;
    const result = await packager.package();
    const outName = result.type === 'application/zip' ? `${name}-${target}.zip` : `${name}.html`;
    const outPath = path.join(config.build.outDir, outName);
    await fsp.writeFile(outPath, result.data);
    outputs.push({ target, outPath, bytes: result.data.length, runnableHere: RUNNABLE_HERE.has(target) || result.type === 'text/html' });
  }
  return { name, outputs };
}

async function main() {
  const Packager = require('@turbowarp/packager');
  const config = load();
  const argv = process.argv.slice(2);
  const targetFlag = argv.find((a) => a.startsWith('--target='));
  const targets = targetFlag ? targetFlag.slice('--target='.length).split(',') : config.build.targets;
  const named = argv.filter((a) => !a.startsWith('--'));

  await fsp.mkdir(config.build.outDir, { recursive: true });
  let files;
  if (named.length) {
    files = named.map((f) => (path.isAbsolute(f) ? f : path.resolve(config.build.projectsDir, f)));
  } else {
    files = (await fsp.readdir(config.build.projectsDir))
      .filter((f) => /\.(sb3|sb2|sb)$/i.test(f))
      .map((f) => path.join(config.build.projectsDir, f));
  }
  if (!files.length) {
    console.log(`No projects found in ${config.build.projectsDir}. Add an .sb3 there (or run: npm run setup).`);
    return;
  }

  const extSource = await fsp.readFile(path.join(config.root, 'extension', 'x70bridge.js'), 'utf8');
  const pairing = { url: bridgeURL(config), token: config.bridge.token };
  console.log(`Bridge baked into builds: ${pairing.url}`);
  console.log(`Targets: ${targets.join(', ')}\n`);

  for (const file of files) {
    process.stdout.write(`${path.basename(file)} ... `);
    try {
      const { outputs } = await buildOne(Packager, config, file, targets, extSource, pairing);
      console.log('ok');
      for (const o of outputs) {
        const size = `${(o.bytes / 1048576).toFixed(2)} MB`;
        console.log(`  ${o.target.padEnd(16)} ${path.relative(config.root, o.outPath)}  (${size})${o.runnableHere ? '  <- open this in your browser' : '  <- download & run on a desktop'}`);
      }
    } catch (e) {
      console.log('FAILED');
      console.error(`  ${e.message}`);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildOne, bridgeURL, bakedExtension };
