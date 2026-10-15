// x70 Bridge: a TurboWarp extension that connects a project to the local x70 bridge daemon
// (scratch/bridge/server.js) for files, commands, system metrics, a Redis cache, SQLite,
// live uncompressed assets and events from Node-RED or other tools.
//
// Must be loaded UNSANDBOXED (TurboWarp: Custom Extension -> "Run without sandbox"; the packager
// always does this). The pipeline's build step bakes the bridge URL and token in; in the editor,
// use the "pair with bridge" block once (the token lives in scratch/data/bridge.token).

(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('x70 Bridge must be loaded without the sandbox');
  }

  const vm = Scratch.vm;
  const runtime = vm.runtime;
  const Cast = Scratch.Cast;

  // Replaced by tools/build.js with {"url": "...", "token": "..."} when packaging.
  const BAKED = null; // @x70-baked

  const STORE = 'x70bridge:pairing';
  const ID = 'x70bridge';

  const readPairing = () => {
    if (BAKED) return BAKED;
    try {
      const p = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (p && p.url && p.token) return p;
    } catch (e) { /* storage unavailable */ }
    return null;
  };

  // --- connection -------------------------------------------------------------------------------

  let pairing = readPairing();
  let socket = null;
  let ready = null;
  let nextId = 1;
  const pending = new Map();
  let lastError = '';
  let lastLatency = -1;
  let lastResult = { code: '', stdout: '', stderr: '' };
  let lastEvent = { name: '', data: '' };
  let welcome = null;
  let retryAt = 0;

  const wsURL = (url) => url.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';

  const fail = (e) => {
    lastError = (e && e.message) || String(e);
    return '';
  };

  function connect() {
    if (ready) return ready;
    if (!pairing) return Promise.reject(new Error('Not paired: use "pair with bridge" first'));
    if (Date.now() < retryAt) return Promise.reject(new Error('Bridge unreachable; retrying shortly'));
    ready = new Promise((resolve, reject) => {
      let s;
      try {
        s = new WebSocket(wsURL(pairing.url));
      } catch (e) {
        ready = null;
        return reject(e);
      }
      let opened = false;
      s.onopen = () => s.send(JSON.stringify({ type: 'hello', token: pairing.token }));
      s.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'welcome') {
          opened = true;
          socket = s;
          welcome = msg;
          lastError = '';
          resolve(s);
        } else if (msg.type === 'event') {
          dispatchEvent(String(msg.name), msg.data);
        } else if (pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
          else p.resolve(msg.result);
        }
      };
      s.onclose = (ev) => {
        socket = null;
        ready = null;
        welcome = null;
        const err = new Error(ev.code === 4003 ? 'Bridge rejected the token' : 'Bridge connection closed');
        for (const p of pending.values()) p.reject(err);
        pending.clear();
        if (!opened) {
          retryAt = Date.now() + 1000;
          reject(err);
        }
      };
      s.onerror = () => { /* onclose follows */ };
    });
    return ready;
  }

  async function call(method, params) {
    const s = await connect();
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      s.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  /** call() for blocks: never throws into the project, records the error instead. */
  const safe = (method, params, map = (x) => x) => call(method, params).then(map).catch(fail);

  const assetURL = (p) => `${pairing.url.replace(/\/$/, '')}/assets/${String(p).split('/').map(encodeURIComponent).join('/')}?t=${encodeURIComponent(pairing.token)}`;

  // --- helpers ---------------------------------------------------------------------------------

  const str = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };

  const findList = (util, name) => {
    const list = util.target.lookupVariableByNameAndType(Cast.toString(name), 'list');
    return list || null;
  };

  const setList = (list, items) => {
    list.value = items.map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : x));
    list._monitorUpToDate = false;
  };

  const parseJSON = (s) => {
    try { return JSON.parse(Cast.toString(s)); } catch (e) { return undefined; }
  };

  const tryParams = (s) => {
    const t = Cast.toString(s).trim();
    if (!t) return [];
    const v = parseJSON(t);
    return v === undefined ? [t] : v;
  };

  // --- events ----------------------------------------------------------------------------------

  function dispatchEvent(name, data) {
    const ev = { name, data: str(data) };
    lastEvent = ev;
    const threads = runtime.startHats(`${ID}_whenEvent`);
    for (const t of threads) t.x70event = ev;
  }

  // --- assets (decoded straight into renderer skins / Web Audio buffers) ------------------------

  const skins = new Map(); // path -> Promise<skinId>
  const sounds = new Map(); // path -> Promise<AudioBuffer>
  const playing = new Set();

  function loadSkin(path) {
    path = Cast.toString(path);
    if (!skins.has(path)) {
      const p = (async () => {
        if (!pairing) throw new Error('Not paired');
        const res = await fetch(assetURL(path));
        if (!res.ok) throw new Error(`Asset ${path}: HTTP ${res.status}`);
        const renderer = vm.renderer;
        if (/\.svg$/i.test(path)) return renderer.createSVGSkin(await res.text());
        const bitmap = await createImageBitmap(await res.blob());
        // name@2x.png is drawn at half size, like Scratch's own bitmap costumes.
        const m = /@(\d+)x\.[a-z0-9]+$/i.exec(path);
        return renderer.createBitmapSkin(bitmap, m ? Number(m[1]) : 1);
      })();
      p.catch(() => skins.delete(path));
      skins.set(path, p);
    }
    return skins.get(path);
  }

  function loadSound(path) {
    path = Cast.toString(path);
    if (!sounds.has(path)) {
      const p = (async () => {
        if (!pairing) throw new Error('Not paired');
        const res = await fetch(assetURL(path));
        if (!res.ok) throw new Error(`Asset ${path}: HTTP ${res.status}`);
        const ctx = runtime.audioEngine.audioContext;
        return ctx.decodeAudioData(await res.arrayBuffer());
      })();
      p.catch(() => sounds.delete(path));
      sounds.set(path, p);
    }
    return sounds.get(path);
  }

  async function playSound(path) {
    const buffer = await loadSound(path);
    const engine = runtime.audioEngine;
    const src = engine.audioContext.createBufferSource();
    src.buffer = buffer;
    src.connect(engine.inputNode);
    playing.add(src);
    const done = new Promise((resolve) => { src.onended = () => { playing.delete(src); resolve(); }; });
    src.start();
    return done;
  }

  runtime.on('PROJECT_STOP_ALL', () => {
    for (const s of playing) { try { s.stop(); } catch (e) { /* already stopped */ } }
    playing.clear();
  });

  // --- menus -----------------------------------------------------------------------------------

  const ROOTS = ['data', 'assets'];

  class X70Bridge {
    getInfo() {
      return {
        id: ID,
        name: 'x70 Bridge',
        color1: '#1f6feb',
        color2: '#1a5fcc',
        color3: '#164fa8',
        blocks: [
          { blockType: Scratch.BlockType.LABEL, text: 'Connection' },
          { opcode: 'pair', blockType: Scratch.BlockType.COMMAND, text: 'pair with bridge [URL] token [TOKEN]',
            arguments: { URL: { type: Scratch.ArgumentType.STRING, defaultValue: 'http://127.0.0.1:7070' },
              TOKEN: { type: Scratch.ArgumentType.STRING, defaultValue: '' } } },
          { opcode: 'connected', blockType: Scratch.BlockType.BOOLEAN, text: 'bridge connected?' },
          { opcode: 'latency', blockType: Scratch.BlockType.REPORTER, text: 'bridge round trip (ms)' },
          { opcode: 'error', blockType: Scratch.BlockType.REPORTER, text: 'last bridge error' },

          { blockType: Scratch.BlockType.LABEL, text: 'Files' },
          { opcode: 'readFile', blockType: Scratch.BlockType.REPORTER, text: 'read file [PATH] in [ROOT]',
            arguments: { PATH: { type: Scratch.ArgumentType.STRING, defaultValue: 'save.json' }, ROOT: { type: Scratch.ArgumentType.STRING, menu: 'roots' } } },
          { opcode: 'writeFile', blockType: Scratch.BlockType.COMMAND, text: '[MODE] [DATA] to file [PATH] in [ROOT]',
            arguments: { MODE: { type: Scratch.ArgumentType.STRING, menu: 'writeMode' }, DATA: { type: Scratch.ArgumentType.STRING, defaultValue: 'hello' },
              PATH: { type: Scratch.ArgumentType.STRING, defaultValue: 'save.json' }, ROOT: { type: Scratch.ArgumentType.STRING, menu: 'roots' } } },
          { opcode: 'fileExists', blockType: Scratch.BlockType.BOOLEAN, text: 'file [PATH] exists in [ROOT]?',
            arguments: { PATH: { type: Scratch.ArgumentType.STRING, defaultValue: 'save.json' }, ROOT: { type: Scratch.ArgumentType.STRING, menu: 'roots' } } },
          { opcode: 'listFiles', blockType: Scratch.BlockType.REPORTER, text: 'files in folder [PATH] of [ROOT]',
            arguments: { PATH: { type: Scratch.ArgumentType.STRING, defaultValue: '' }, ROOT: { type: Scratch.ArgumentType.STRING, menu: 'roots' } } },
          { opcode: 'deleteFile', blockType: Scratch.BlockType.COMMAND, text: 'delete file [PATH] in [ROOT]',
            arguments: { PATH: { type: Scratch.ArgumentType.STRING, defaultValue: 'old.txt' }, ROOT: { type: Scratch.ArgumentType.STRING, menu: 'roots' } } },
          { opcode: 'saveList', blockType: Scratch.BlockType.COMMAND, text: 'save list [LIST] to file [PATH] in [ROOT]',
            arguments: { LIST: { type: Scratch.ArgumentType.STRING, menu: 'lists' }, PATH: { type: Scratch.ArgumentType.STRING, defaultValue: 'list.txt' },
              ROOT: { type: Scratch.ArgumentType.STRING, menu: 'roots' } } },
          { opcode: 'loadList', blockType: Scratch.BlockType.COMMAND, text: 'load file [PATH] in [ROOT] into list [LIST]',
            arguments: { PATH: { type: Scratch.ArgumentType.STRING, defaultValue: 'list.txt' }, ROOT: { type: Scratch.ArgumentType.STRING, menu: 'roots' },
              LIST: { type: Scratch.ArgumentType.STRING, menu: 'lists' } } },

          { blockType: Scratch.BlockType.LABEL, text: 'Commands & system' },
          { opcode: 'runCommand', blockType: Scratch.BlockType.COMMAND, text: 'run command [NAME] with args [ARGS]',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'node-version' }, ARGS: { type: Scratch.ArgumentType.STRING, defaultValue: '[]' } } },
          { opcode: 'runCommandOutput', blockType: Scratch.BlockType.REPORTER, text: 'output of command [NAME] with args [ARGS]',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'node-version' }, ARGS: { type: Scratch.ArgumentType.STRING, defaultValue: '[]' } } },
          { opcode: 'lastCommand', blockType: Scratch.BlockType.REPORTER, text: 'last command [FIELD]',
            arguments: { FIELD: { type: Scratch.ArgumentType.STRING, menu: 'commandField' } } },
          { opcode: 'system', blockType: Scratch.BlockType.REPORTER, text: 'system [METRIC]',
            arguments: { METRIC: { type: Scratch.ArgumentType.STRING, menu: 'metric' } } },

          { blockType: Scratch.BlockType.LABEL, text: 'Cache (Redis)' },
          { opcode: 'cacheSet', blockType: Scratch.BlockType.COMMAND, text: 'cache set [KEY] to [VALUE]',
            arguments: { KEY: { type: Scratch.ArgumentType.STRING, defaultValue: 'score' }, VALUE: { type: Scratch.ArgumentType.STRING, defaultValue: '0' } } },
          { opcode: 'cacheGet', blockType: Scratch.BlockType.REPORTER, text: 'cache get [KEY]',
            arguments: { KEY: { type: Scratch.ArgumentType.STRING, defaultValue: 'score' } } },
          { opcode: 'cacheChange', blockType: Scratch.BlockType.COMMAND, text: 'cache change [KEY] by [BY]',
            arguments: { KEY: { type: Scratch.ArgumentType.STRING, defaultValue: 'score' }, BY: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 } } },
          { opcode: 'cacheDelete', blockType: Scratch.BlockType.COMMAND, text: 'cache delete [KEY]',
            arguments: { KEY: { type: Scratch.ArgumentType.STRING, defaultValue: 'score' } } },
          { opcode: 'cacheStoreList', blockType: Scratch.BlockType.COMMAND, text: 'cache store list [LIST] as [KEY]',
            arguments: { LIST: { type: Scratch.ArgumentType.STRING, menu: 'lists' }, KEY: { type: Scratch.ArgumentType.STRING, defaultValue: 'world' } } },
          { opcode: 'cacheLoadList', blockType: Scratch.BlockType.COMMAND, text: 'cache load [KEY] into list [LIST]',
            arguments: { KEY: { type: Scratch.ArgumentType.STRING, defaultValue: 'world' }, LIST: { type: Scratch.ArgumentType.STRING, menu: 'lists' } } },

          { blockType: Scratch.BlockType.LABEL, text: 'Database (SQLite)' },
          { opcode: 'sqlRun', blockType: Scratch.BlockType.COMMAND, text: 'SQL run [SQL] with [PARAMS]',
            arguments: { SQL: { type: Scratch.ArgumentType.STRING, defaultValue: 'CREATE TABLE IF NOT EXISTS scores (name TEXT, score REAL)' },
              PARAMS: { type: Scratch.ArgumentType.STRING, defaultValue: '[]' } } },
          { opcode: 'sqlQuery', blockType: Scratch.BlockType.REPORTER, text: 'SQL query [SQL] with [PARAMS] as JSON',
            arguments: { SQL: { type: Scratch.ArgumentType.STRING, defaultValue: 'SELECT * FROM scores ORDER BY score DESC LIMIT 10' },
              PARAMS: { type: Scratch.ArgumentType.STRING, defaultValue: '[]' } } },
          { opcode: 'sqlQueryList', blockType: Scratch.BlockType.COMMAND, text: 'SQL query [SQL] with [PARAMS] into list [LIST]',
            arguments: { SQL: { type: Scratch.ArgumentType.STRING, defaultValue: 'SELECT name FROM scores' },
              PARAMS: { type: Scratch.ArgumentType.STRING, defaultValue: '[]' }, LIST: { type: Scratch.ArgumentType.STRING, menu: 'lists' } } },
          { opcode: 'sqlInsertList', blockType: Scratch.BlockType.COMMAND, text: 'SQL insert list [LIST] into table [TABLE] column [COLUMN]',
            arguments: { LIST: { type: Scratch.ArgumentType.STRING, menu: 'lists' }, TABLE: { type: Scratch.ArgumentType.STRING, defaultValue: 'items' },
              COLUMN: { type: Scratch.ArgumentType.STRING, defaultValue: 'value' } } },
          { opcode: 'sqlLastId', blockType: Scratch.BlockType.REPORTER, text: 'SQL last insert id' },

          { blockType: Scratch.BlockType.LABEL, text: 'JSON' },
          { opcode: 'jsonGet', blockType: Scratch.BlockType.REPORTER, text: 'item [KEY] of JSON [JSON]',
            arguments: { KEY: { type: Scratch.ArgumentType.STRING, defaultValue: '0' }, JSON: { type: Scratch.ArgumentType.STRING, defaultValue: '["a","b"]' } } },
          { opcode: 'jsonLength', blockType: Scratch.BlockType.REPORTER, text: 'length of JSON [JSON]',
            arguments: { JSON: { type: Scratch.ArgumentType.STRING, defaultValue: '["a","b"]' } } },

          { blockType: Scratch.BlockType.LABEL, text: 'Live assets' },
          { opcode: 'setCostumeAsset', blockType: Scratch.BlockType.COMMAND, text: 'set my costume to asset [PATH]',
            arguments: { PATH: { type: Scratch.ArgumentType.STRING, defaultValue: 'player.png' } } },
          { opcode: 'restoreCostume', blockType: Scratch.BlockType.COMMAND, text: 'restore my costume' },
          { opcode: 'preloadAsset', blockType: Scratch.BlockType.COMMAND, text: 'preload asset [PATH]',
            arguments: { PATH: { type: Scratch.ArgumentType.STRING, defaultValue: 'player.png' } } },
          { opcode: 'playAsset', blockType: Scratch.BlockType.COMMAND, text: 'start asset sound [PATH]',
            arguments: { PATH: { type: Scratch.ArgumentType.STRING, defaultValue: 'music.flac' } } },
          { opcode: 'playAssetUntilDone', blockType: Scratch.BlockType.COMMAND, text: 'play asset sound [PATH] until done',
            arguments: { PATH: { type: Scratch.ArgumentType.STRING, defaultValue: 'music.flac' } } },
          { opcode: 'stopAssetSounds', blockType: Scratch.BlockType.COMMAND, text: 'stop all asset sounds' },
          { opcode: 'listAssets', blockType: Scratch.BlockType.REPORTER, text: 'all assets' },

          { blockType: Scratch.BlockType.LABEL, text: 'Events (Node-RED, scripts)' },
          { opcode: 'whenEvent', blockType: Scratch.BlockType.HAT, text: 'when I receive bridge event [NAME]', isEdgeActivated: false,
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'tick' } } },
          { opcode: 'eventData', blockType: Scratch.BlockType.REPORTER, text: 'bridge event data' },
          { opcode: 'publish', blockType: Scratch.BlockType.COMMAND, text: 'send bridge event [NAME] with data [DATA]',
            arguments: { NAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'hello' }, DATA: { type: Scratch.ArgumentType.STRING, defaultValue: '' } } },

        ],
        menus: {
          roots: { acceptReporters: true, items: ROOTS },
          writeMode: { acceptReporters: false, items: ['write', 'append'] },
          lists: { acceptReporters: true, items: 'listMenu' },
          commandField: { acceptReporters: false, items: ['output', 'errors', 'exit code', 'time (ms)'] },
          metric: { acceptReporters: true, items: ['cpu %', 'memory %', 'free memory (MB)', 'total memory (MB)', 'cpu cores', 'cpu model', 'load average', 'platform', 'hostname', 'uptime (s)', 'cache type'] },
        },
      };
    }

    listMenu() {
      const names = new Set();
      const add = (t) => {
        if (!t) return;
        for (const v of Object.values(t.variables)) if (v.type === 'list') names.add(v.name);
      };
      add(runtime.getTargetForStage());
      add(vm.editingTarget);
      return names.size ? [...names].sort() : [''];
    }

    // connection
    pair({ URL, TOKEN }) {
      const url = Cast.toString(URL).trim().replace(/\/$/, '');
      const token = Cast.toString(TOKEN).trim();
      // Accept a loopback address (http or https) or any HTTPS URL — the latter covers a
      // Codespaces forwarded port or a tunnel. Plaintext http to a non-loopback host is refused
      // (insecure, and browsers block it as mixed content on an https page anyway).
      let parsed;
      try { parsed = new URL(url); } catch (e) { parsed = null; }
      const loopback = parsed && /^(127\.0\.0\.1|localhost|\[?::1\]?)$/.test(parsed.hostname);
      const ok = parsed && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback));
      if (!ok) {
        lastError = 'The bridge URL must be http://127.0.0.1:7070 or an https:// address (e.g. your Codespaces forwarded port)';
        return;
      }
      if (socket) socket.close();
      ready = null;
      retryAt = 0;
      pairing = { url, token };
      if (!BAKED) {
        try { localStorage.setItem(STORE, JSON.stringify(pairing)); } catch (e) { /* not persisted */ }
      }
      skins.clear();
      sounds.clear();
      return connect().then(() => {}, fail);
    }

    connected() {
      if (!socket && pairing && !ready) connect().catch(fail);
      return !!socket;
    }

    latency() {
      const t = performance.now();
      return call('sys.ping').then(() => (lastLatency = Math.round((performance.now() - t) * 100) / 100), (e) => { fail(e); return lastLatency; });
    }

    error() { return lastError; }

    // files
    readFile({ PATH, ROOT }) { return safe('fs.read', { root: Cast.toString(ROOT), path: Cast.toString(PATH) }); }
    writeFile({ MODE, DATA, PATH, ROOT }) {
      return safe('fs.write', { root: Cast.toString(ROOT), path: Cast.toString(PATH), data: Cast.toString(DATA), append: MODE === 'append' });
    }
    fileExists({ PATH, ROOT }) { return safe('fs.stat', { root: Cast.toString(ROOT), path: Cast.toString(PATH) }, (s) => !!s.exists).then((v) => v === true); }
    listFiles({ PATH, ROOT }) { return safe('fs.list', { root: Cast.toString(ROOT), path: Cast.toString(PATH) }, str); }
    deleteFile({ PATH, ROOT }) { return safe('fs.delete', { root: Cast.toString(ROOT), path: Cast.toString(PATH) }); }
    saveList({ LIST, PATH, ROOT }, util) {
      const list = findList(util, LIST);
      if (!list) return fail(new Error(`No list named ${LIST}`));
      return safe('fs.write', { root: Cast.toString(ROOT), path: Cast.toString(PATH), data: list.value.join('\n') });
    }
    loadList({ PATH, ROOT, LIST }, util) {
      const list = findList(util, LIST);
      if (!list) return fail(new Error(`No list named ${LIST}`));
      return call('fs.read', { root: Cast.toString(ROOT), path: Cast.toString(PATH) })
        .then((text) => setList(list, text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')), fail);
    }

    // commands & system
    _run(NAME, ARGS) {
      const args = tryParams(ARGS);
      return call('exec.run', { name: Cast.toString(NAME), args: Array.isArray(args) ? args : [args] }).then((r) => {
        lastResult = r;
        if (r.code !== 0) lastError = `${NAME} exited with ${r.code}${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''}`;
        return r;
      });
    }
    runCommand({ NAME, ARGS }) { return this._run(NAME, ARGS).then(() => {}, fail); }
    runCommandOutput({ NAME, ARGS }) { return this._run(NAME, ARGS).then((r) => r.stdout.replace(/\r?\n$/, ''), fail); }
    lastCommand({ FIELD }) {
      switch (FIELD) {
        case 'errors': return lastResult.stderr || '';
        case 'exit code': return lastResult.code;
        case 'time (ms)': return lastResult.ms || 0;
        default: return lastResult.stdout || '';
      }
    }
    system({ METRIC }) {
      const m = Cast.toString(METRIC);
      if (['cpu cores', 'cpu model', 'platform', 'hostname', 'cache type', 'total memory (MB)'].includes(m)) {
        return safe('sys.info', {}, (i) => ({
          'cpu cores': i.cpus, 'cpu model': i.cpuModel, platform: i.platform, hostname: i.hostname,
          'cache type': i.kv, 'total memory (MB)': Math.round(i.totalMem / 1048576),
        })[m]);
      }
      return safe('sys.metrics', {}, (x) => ({
        'cpu %': x.cpuPercent, 'memory %': x.memPercent, 'free memory (MB)': Math.round(x.freeMem / 1048576),
        'load average': Math.round(x.loadavg * 100) / 100, 'uptime (s)': Math.round(x.uptime),
      })[m] ?? '');
    }

    // cache
    cacheSet({ KEY, VALUE }) { return safe('kv.set', { key: Cast.toString(KEY), value: Cast.toString(VALUE) }); }
    cacheGet({ KEY }) { return safe('kv.get', { key: Cast.toString(KEY) }, str); }
    cacheChange({ KEY, BY }) { return safe('kv.incr', { key: Cast.toString(KEY), by: Cast.toNumber(BY) }); }
    cacheDelete({ KEY }) { return safe('kv.del', { key: Cast.toString(KEY) }); }
    cacheStoreList({ LIST, KEY }, util) {
      const list = findList(util, LIST);
      if (!list) return fail(new Error(`No list named ${LIST}`));
      return safe('list.replace', { key: Cast.toString(KEY), items: list.value.map(String) });
    }
    cacheLoadList({ KEY, LIST }, util) {
      const list = findList(util, LIST);
      if (!list) return fail(new Error(`No list named ${LIST}`));
      return call('list.range', { key: Cast.toString(KEY) }).then((items) => setList(list, items), fail);
    }

    // sql
    sqlRun({ SQL, PARAMS }) {
      return call('sql.run', { sql: Cast.toString(SQL), params: tryParams(PARAMS) }).then((r) => { this._lastId = r.lastInsertRowid; }, fail);
    }
    sqlQuery({ SQL, PARAMS }) { return safe('sql.query', { sql: Cast.toString(SQL), params: tryParams(PARAMS) }, str); }
    sqlQueryList({ SQL, PARAMS, LIST }, util) {
      const list = findList(util, LIST);
      if (!list) return fail(new Error(`No list named ${LIST}`));
      return call('sql.query', { sql: Cast.toString(SQL), params: tryParams(PARAMS) }).then((rows) => {
        // One column -> its values; several -> one JSON object per item.
        setList(list, rows.map((r) => { const v = Object.values(r); return v.length === 1 ? (v[0] ?? '') : r; }));
      }, fail);
    }
    sqlInsertList({ LIST, TABLE, COLUMN }, util) {
      const list = findList(util, LIST);
      if (!list) return fail(new Error(`No list named ${LIST}`));
      return safe('sql.insertMany', { table: Cast.toString(TABLE), columns: [Cast.toString(COLUMN)], rows: list.value.map((v) => [v]) });
    }
    sqlLastId() { return this._lastId ?? ''; }

    // json
    jsonGet({ KEY, JSON: J }) {
      const v = parseJSON(J);
      if (v === undefined || v === null || typeof v !== 'object') return '';
      const k = Cast.toString(KEY);
      return str(Array.isArray(v) ? v[Number(k)] : v[k]);
    }
    jsonLength({ JSON: J }) {
      const v = parseJSON(J);
      if (Array.isArray(v)) return v.length;
      return v && typeof v === 'object' ? Object.keys(v).length : 0;
    }

    // assets
    setCostumeAsset({ PATH }, util) {
      if (util.target.isStage) return fail(new Error('The stage cannot use asset costumes'));
      return loadSkin(PATH).then((skinId) => {
        vm.renderer.updateDrawableSkinId(util.target.drawableID, skinId);
        runtime.requestRedraw();
      }, fail);
    }
    restoreCostume(_, util) {
      const t = util.target;
      t.setCostume(t.currentCostume);
      const costume = t.getCostumes()[t.currentCostume];
      if (costume && vm.renderer) vm.renderer.updateDrawableSkinId(t.drawableID, costume.skinId);
      runtime.requestRedraw();
    }
    preloadAsset({ PATH }) {
      const p = Cast.toString(PATH);
      return (/\.(wav|mp3|ogg|flac|m4a|opus)$/i.test(p) ? loadSound(p) : loadSkin(p)).then(() => {}, fail);
    }
    playAsset({ PATH }) {
      playSound(PATH).catch(fail);
      return loadSound(PATH).then(() => {}, () => {});
    }
    playAssetUntilDone({ PATH }) { return playSound(PATH).catch(fail); }
    stopAssetSounds() {
      for (const s of playing) { try { s.stop(); } catch (e) { /* already stopped */ } }
      playing.clear();
    }
    listAssets() { return safe('assets.list', {}, str); }

    // events
    whenEvent({ NAME }, util) {
      const ev = util.thread.x70event;
      return !!ev && ev.name === Cast.toString(NAME);
    }
    eventData(_, util) {
      const ev = util.thread.x70event || lastEvent;
      return ev.data;
    }
    publish({ NAME, DATA }) { return safe('events.publish', { name: Cast.toString(NAME), data: Cast.toString(DATA) }).then(() => {}); }

  }

  // Connect eagerly so the first block call does not pay for the handshake.
  if (pairing) connect().catch(fail);

  Scratch.extensions.register(new X70Bridge());
})(Scratch);
