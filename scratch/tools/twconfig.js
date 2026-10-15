'use strict';

// Turn the pipeline's runtime settings into the two shapes TurboWarp understands:
//   - packagerOptions(): the fields set on a @turbowarp/packager Packager before building.
//   - stamp(sb3Buffer): writes a stage comment ending in ` // _twconfig_`, so opening the .sb3
//     in the TurboWarp editor shows the same unlocked settings (framerate 0 = match the monitor,
//     infinite clones, no fencing, no misc limits, interpolation, high-quality pen).

const JSZip = require('jszip');

const MARKER = ' // _twconfig_';
const HEADER =
  'Configuration for https://turbowarp.org/\n' +
  "You can move, resize, and minimize this comment, but don't edit it by hand. " +
  'This comment can be deleted to remove the stored settings.\n';

/** JSON that keeps Infinity / -Infinity / NaN as bare literals, the way TurboWarp's parser reads them. */
function twStringify(value) {
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(twStringify).join(',')}]`;
  return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}:${twStringify(v)}`).join(',')}}`;
}

/** The subset of settings TurboWarp stores in the project comment (only values that differ from stock). */
function storedOptions(rt) {
  const o = {};
  if (rt.framerate !== 30) o.framerate = rt.framerate;
  if (rt.turbo) o.turbo = true;
  if (rt.interpolation) o.interpolation = true;
  if (rt.highQualityPen) o.hq = true;
  const runtimeOptions = {};
  if (rt.maxClones !== 300) runtimeOptions.maxClones = rt.maxClones;
  if (rt.miscLimits === false) runtimeOptions.miscLimits = false;
  if (rt.fencing === false) runtimeOptions.fencing = false;
  if (Object.keys(runtimeOptions).length) o.runtimeOptions = runtimeOptions;
  if (rt.stageWidth !== 480) o.width = rt.stageWidth;
  if (rt.stageHeight !== 360) o.height = rt.stageHeight;
  return o;
}

function commentText(rt) {
  return HEADER + twStringify(storedOptions(rt)) + MARKER;
}

/** Options for @turbowarp/packager. Only the properties we change from its defaults. */
function packagerOptions(config) {
  const rt = config.runtime;
  const bd = config.build;
  return (packager) => {
    packager.options.turbo = rt.turbo;
    packager.options.interpolation = rt.interpolation;
    packager.options.framerate = rt.framerate;
    packager.options.highQualityPen = rt.highQualityPen;
    packager.options.maxClones = rt.maxClones;
    packager.options.fencing = rt.fencing;
    packager.options.miscLimits = rt.miscLimits;
    packager.options.stageWidth = rt.stageWidth;
    packager.options.stageHeight = rt.stageHeight;
    packager.options.maxTextureDimension = rt.maxTextureDimension;
    packager.options.compiler.enabled = true;
    packager.options.compiler.warpTimer = rt.warpTimer;
    packager.options.app.version = bd.appVersion;
    packager.options.app.windowMode = bd.windowMode;
    packager.options.app.backgroundThrottling = false;
  };
}

const rid = () => {
  let s = '';
  const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_!#%()*+,./:;=?@[]^`{|}~';
  for (let i = 0; i < 20; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
};

/**
 * Write (or replace) the TurboWarp settings comment on the stage of an .sb3. Returns a new Buffer.
 * A bare project.json (not zipped) is handled too.
 */
async function stamp(buffer, rt) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file('project.json');
  if (!entry) throw new Error('Not an .sb3: no project.json inside');
  const project = JSON.parse(await entry.async('string'));
  const stage = (project.targets || []).find((t) => t.isStage);
  if (!stage) throw new Error('Project has no stage');
  stage.comments = stage.comments || {};
  const text = commentText(rt);
  const existing = Object.keys(stage.comments).find((id) => String(stage.comments[id].text || '').endsWith(MARKER));
  if (existing) {
    stage.comments[existing].text = text;
  } else {
    stage.comments[rid()] = { blockId: null, x: 32, y: 32, width: 360, height: 180, minimized: true, text };
  }
  zip.file('project.json', JSON.stringify(project));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

module.exports = { twStringify, storedOptions, commentText, packagerOptions, stamp, MARKER };

if (require.main === module) {
  const { load } = require('../bridge/config');
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node tools/twconfig.js <project.sb3>   (stamps the pipeline settings into the file)');
    process.exit(1);
  }
  const config = load();
  stamp(fs.readFileSync(file), config.runtime)
    .then((out) => { fs.writeFileSync(file, out); console.log(`Stamped TurboWarp settings into ${file}`); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
