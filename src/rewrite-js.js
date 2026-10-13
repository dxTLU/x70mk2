/*
 * JavaScript rewriter. Isomorphic: a CommonJS module under Node, and in a browser (no
 * module.exports) it publishes globalThis.__proxyRewriteJs = { rewriteJs, rewriteScript } so the
 * client runtime can rewrite code that pages build at runtime (eval, Function, string timers).
 * It must therefore stay free of Node-only APIs and keep everything inside the wrapper below.
 *
 * Pages read `location` / `window.location` to learn where they are. Under the proxy the real
 * location is /p/https://site/..., which confuses routers and URL builders. We rename every
 * `location` reference (bare or as a property) to `__pLocation`. The browser runtime defines
 * `Object.prototype.__pLocation`, which returns a virtual Location for windows/documents and
 * falls through to the ordinary `.location` property for any other object, so renaming is
 * safe for unrelated objects that happen to have a `location` field.
 *
 * Where the name is not a reference it keeps its meaning: object literal keys, methods and class
 * members still define a real `location` property, import/export specifiers keep the name other
 * modules see (an export named `location` also gets an `__pLocation` twin, since namespace
 * objects have no prototype getter), `#location` and `super.location` are left alone.
 * Destructuring patterns read through `__pLocation`, so `const { location } = window` also gets
 * the virtual Location, except beside a `...rest` element, which must keep excluding the real key.
 *
 * Direct `eval(code)` calls become `eval(__pRewriteJs(code))`: still a direct eval (same scope),
 * while the evaluated source gets the same treatment.
 *
 * Pass 1 is a tokenizer with an acorn-style context stack, which is what it takes to tell regular
 * expressions from division, blocks from object literals and to follow nested templates. Pass 2
 * looks only at the `location` / `eval` tokens and classifies each one from its neighbours.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && typeof module.exports === 'object') module.exports = api;
  else if (root) Object.defineProperty(root, '__proxyRewriteJs', { value: api, configurable: true, writable: true });
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : undefined, function () {
  'use strict';

  const NAME = 'location';
  const REPLACEMENT = '__pLocation';
  const EVAL_HOOK = '__pRewriteJs';

  // Prepended to standalone scripts so the names the rewrite introduces exist even where the
  // browser runtime is absent (workers). It never mentions `location` as an identifier, so
  // rewriting it again is harmless. The @@unscopables entries stop object scopes from capturing
  // `__pLocation` (every object inherits it): `with (obj)` unless obj really has a `location`,
  // and the element/form/document scopes of inline event handlers, where the bare name must
  // reach the window as `location` does. That unscopables object has a null prototype: an
  // inherited `toString` or `constructor` would be truthy and hide the with-object's own.
  const GUARD =
    'if(!Object.prototype.hasOwnProperty("__pLocation"))try{Object.defineProperty(Object.prototype,"__pLocation",' +
    '{configurable:true,get:function(){return this["location"]},set:function(v){this["location"]=v}})}catch(e){}' +
    '(function(G,O,U){function d(o,k,v){try{Object.defineProperty(o,k,v)}catch(e){}}' +
    'if(typeof G.__pRewriteJs!="function")d(G,"__pRewriteJs",{configurable:true,writable:true,value:function(s){return s}});' +
    'if(U&&!O.hasOwnProperty(U))d(O,U,{configurable:true,get:function(){var o=this;return{__proto__:null,get __pLocation(){return!("location"in o)}}}});' +
    '["Array","Element","Document","DocumentFragment","CharacterData","DocumentType"].forEach(function(n){try{' +
    'var u=Object.getOwnPropertyDescriptor(G[n].prototype,U).value;' +
    'if(typeof u=="object"&&!O.hasOwnProperty.call(u,"__pLocation"))d(u,"__pLocation",{configurable:true,value:true})}catch(e){}})' +
    '})(typeof globalThis!="undefined"?globalThis:self,Object.prototype,typeof Symbol=="function"&&Symbol.unscopables);';

  // Token types. Punctuators get their own types so a single array describes every token.
  const T_NAME = 1, T_NUM = 2, T_STR = 3, T_TMPL = 4, T_TMPL_HEAD = 5, T_TMPL_MID = 6, T_TMPL_TAIL = 7,
    T_REGEX = 8, T_PRIVATE = 9;
  const P_LBRACE = 10, P_RBRACE = 11, P_LPAREN = 12, P_RPAREN = 13, P_LBRACK = 14, P_RBRACK = 15,
    P_SEMI = 16, P_COMMA = 17, P_COLON = 18, P_QUESTION = 19, P_DOT = 20, P_QDOT = 21, P_ELLIPSIS = 22,
    P_ARROW = 23, P_ASSIGN = 24, P_INCDEC = 25, P_STAR = 26, P_OP = 27, P_AT = 28;

  // What a `{` opens (aux of P_LBRACE).
  const B_BLOCK = 1, B_OBJECT = 2, B_CLASS = 3, B_CLASS_EXPR = 4, B_FN = 5, B_FN_EXPR = 6, B_MODULE = 7;
  // Whether a regex may follow the matching `}`: statements yes, expressions no.
  const AFTER_BRACE = [true, true, false, true, false, true, false, true];
  // What a `(` opens (aux of P_LPAREN).
  const R_EXPR = 1, R_STMT = 2, R_FN = 3, R_FN_EXPR = 4;
  const COLON_TERNARY = 1; // aux of P_COLON

  // Words the passes care about (aux of T_NAME; 0 for any other identifier).
  const WORDS = [
    'location', 'eval', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from',
    'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'set',
    'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
    'yield', 'accessor',
  ];
  const WORD_CODE = new Map(WORDS.map((w, k) => [w, k + 1]));
  const word = (w) => WORD_CODE.get(w);
  // `location` and `eval` must keep the two lowest codes (see `a <= W_EVAL` below).
  const W_LOCATION = word('location'), W_EVAL = word('eval'), W_AS = word('as'), W_ASYNC = word('async'),
    W_AWAIT = word('await'), W_CATCH = word('catch'), W_CLASS = word('class'), W_DEFAULT = word('default'), W_DO = word('do'),
    W_ELSE = word('else'), W_EXPORT = word('export'), W_FINALLY = word('finally'), W_FOR = word('for'),
    W_FROM = word('from'), W_FUNCTION = word('function'), W_GET = word('get'), W_IF = word('if'),
    W_IMPORT = word('import'), W_IN = word('in'), W_NEW = word('new'), W_OF = word('of'), W_RETURN = word('return'),
    W_SET = word('set'), W_STATIC = word('static'), W_SUPER = word('super'), W_SWITCH = word('switch'),
    W_TRY = word('try'), W_WHILE = word('while'), W_WITH = word('with'), W_YIELD = word('yield'),
    W_ACCESSOR = word('accessor');

  // Keywords after which an expression starts (so `/` begins a regex).
  const F_EXPR = 1;
  // Declarations whose `{` is a destructuring pattern.
  const F_DECL = 2;
  const WFLAG = new Uint8Array(WORDS.length + 1);
  for (const w of ['await', 'case', 'default', 'delete', 'do', 'else', 'extends', 'in', 'instanceof', 'new',
    'return', 'throw', 'typeof', 'void', 'yield']) WFLAG[WORD_CODE.get(w)] |= F_EXPR;
  for (const w of ['const', 'let', 'var']) WFLAG[WORD_CODE.get(w)] |= F_DECL;

  // Open-addressing table keyed by a rolling hash of all-lowercase identifiers, so the hot loop
  // can find keywords without slicing a string per identifier.
  const WORD_SLOTS = 511;
  const WORD_TABLE = new Uint8Array(WORD_SLOTS + 1);
  const wordHash = (h) => (h ^ (h >>> 9)) & WORD_SLOTS;
  for (const [w, code] of WORD_CODE) {
    let h = 0;
    for (let k = 0; k < w.length; k++) h = (Math.imul(h, 31) + w.charCodeAt(k)) | 0;
    let slot = wordHash(h);
    while (WORD_TABLE[slot] !== 0) slot = (slot + 1) & WORD_SLOTS;
    WORD_TABLE[slot] = code;
  }
  function lookupWord(src, s, len, h) {
    for (let slot = wordHash(h); WORD_TABLE[slot] !== 0; slot = (slot + 1) & WORD_SLOTS) {
      const w = WORDS[WORD_TABLE[slot] - 1];
      if (w.length === len && src.startsWith(w, s)) return WORD_TABLE[slot];
    }
    return 0;
  }

  // ASCII character classes for the main loop.
  const C_PUNCT = 0, C_IDENT = 1, C_DIGIT = 2, C_SPACE = 3, C_BREAK = 4;
  const CHAR_CLASS = new Uint8Array(128);
  const ID_PART = new Uint8Array(128);
  for (let c = 0; c < 128; c++) {
    const letter = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95 || c === 92;
    const digit = c >= 48 && c <= 57;
    CHAR_CLASS[c] = letter ? C_IDENT : digit ? C_DIGIT : c === 32 || c === 9 || c === 11 || c === 12 ? C_SPACE
      : c === 10 || c === 13 ? C_BREAK : C_PUNCT;
    ID_PART[c] = letter || digit ? 1 : 0;
  }

  function isSpaceOrBreak(c) {
    return c === 0xa0 || c === 0xfeff || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
      c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
  }

  function isIdPart(c) {
    return c < 128 ? ID_PART[c] === 1 : !isSpaceOrBreak(c);
  }

  /** End of the identifier starting at i (handles \u escapes). */
  function identEnd(src, i) {
    const n = src.length;
    for (;;) {
      if (src.charCodeAt(i) === 92 && src.charCodeAt(i + 1) === 117) {
        if (src.charCodeAt(i + 2) === 123) { const e = src.indexOf('}', i + 3); i = e === -1 ? n : e + 1; }
        else i += 6;
      } else {
        i++;
      }
      if (i >= n) return n;
      if (!isIdPart(src.charCodeAt(i))) return i;
    }
  }

  function isLineBreak(c) {
    return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
  }

  /** Index of the line terminator ending the line comment that starts at i (or the end). */
  function lineEnd(src, i, n) {
    while (i < n && !isLineBreak(src.charCodeAt(i))) i++;
    return i;
  }

  function scanString(src, i, n, q) {
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === q) return i + 1;
      if (c === 92) {
        i += src.charCodeAt(i + 1) === 13 && src.charCodeAt(i + 2) === 10 ? 3 : 2;
        continue;
      }
      if (c === 10 || c === 13) return i; // unterminated: stop at the line end like the engine would
      i++;
    }
    return n;
  }

  let tmplSubst = false; // set by scanTemplate: the chunk ended with `${` rather than a backtick
  function scanTemplate(src, i, n) {
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 96) { tmplSubst = false; return i + 1; }
      if (c === 92) { i += 2; continue; }
      if (c === 36 && src.charCodeAt(i + 1) === 123) { tmplSubst = true; return i + 2; }
      i++;
    }
    tmplSubst = false;
    return n;
  }

  // A failed regex scan runs to the end of the line, and every later `/` on that line may start
  // another one: hostile input like `/[/[/[...` on one long line would cost quadratic time. The
  // scan is a pure function of (position, inside a class), so failures are remembered per state
  // (bit 1: outside a class, bit 2: inside) and a later scan stops as soon as it joins a known
  // failing path. Allocated on the first long failure only.
  let regexFail = null;
  const REGEX_FAIL_MEMO_MIN = 64;

  /** End of a regex literal whose body starts at i (just past the `/`), or -1 if there is none. */
  function scanRegex(src, i, n) {
    const s = i;
    let inClass = false;
    while (i < n) {
      if (regexFail !== null && (regexFail[i] & (inClass ? 2 : 1)) !== 0) break;
      const c = src.charCodeAt(i);
      if (c === 92) {
        if (isLineBreak(src.charCodeAt(i + 1))) break;
        i += 2;
        continue;
      }
      if (isLineBreak(c)) break;
      if (inClass) {
        if (c === 93) inClass = false;
      } else if (c === 91) {
        inClass = true;
      } else if (c === 47) {
        i++;
        while (i < n && isIdPart(src.charCodeAt(i))) i++;
        return i;
      }
      i++;
    }
    if (i - s >= REGEX_FAIL_MEMO_MIN) markRegexFail(src, s, Math.min(i, n), n);
    return -1;
  }

  // Replay the failed scan from s up to where it stopped, recording each state it passed through.
  function markRegexFail(src, i, stop, n) {
    if (regexFail === null) regexFail = new Uint8Array(n + 1);
    let inClass = false;
    while (i < stop) {
      regexFail[i] |= inClass ? 2 : 1;
      const c = src.charCodeAt(i);
      if (c === 92) { i += 2; continue; }
      if (inClass) { if (c === 93) inClass = false; }
      else if (c === 91) inClass = true;
      i++;
    }
  }

  /** End of a numeric literal; `fraction` when its leading `.` was already consumed (`.5`). */
  function scanNumber(src, i, n, fraction) {
    let c = src.charCodeAt(i);
    if (c === 48 && !fraction) {
      const x = src.charCodeAt(i + 1) | 32;
      if (x === 120 || x === 111 || x === 98) { // 0x 0o 0b
        i += 2;
        while (i < n && isIdPart(src.charCodeAt(i)) && src.charCodeAt(i) !== 92) i++;
        return i;
      }
    }
    while (i < n && (((c = src.charCodeAt(i)) >= 48 && c <= 57) || c === 95)) i++;
    if (c === 46 && !fraction) {
      i++;
      while (i < n && (((c = src.charCodeAt(i)) >= 48 && c <= 57) || c === 95)) i++;
    }
    if ((c | 32) === 101) { // exponent
      const d = src.charCodeAt(i + 1);
      if ((d >= 48 && d <= 57) || ((d === 43 || d === 45) && src.charCodeAt(i + 2) >= 48 && src.charCodeAt(i + 2) <= 57)) {
        i += 2;
        while (i < n && (((c = src.charCodeAt(i)) >= 48 && c <= 57) || c === 95)) i++;
      }
    }
    if (c === 110) i++; // BigInt suffix
    return i;
  }

  /** Decode \uXXXX / \u{X} escapes in an identifier. */
  function decodeIdent(s) {
    return s.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g, (m, a, b) => {
      const cp = parseInt(a || b, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
  }

  /*
   * Pass 1: tokenize into parallel typed arrays (comments and whitespace are dropped).
   *   start  source offset; type  T_* / P_*; aux  word code, `{`/`(` kind or ternary flag;
   *   nlb  a line break precedes the token; match  partner of a bracket (-1 if unbalanced);
   *   parent  innermost enclosing bracket (-1 at top level), recorded for brackets and hits only.
   * `hits` lists every `location` / `eval` token.
   *
   * This loop runs once per token of multi-megabyte bundles, so: the arrays are written sparsely
   * (they start zeroed), and the state lives in this scope rather than in closures created per
   * call, which would hand the optimizer a new call target (and a deopt) on every call.
   */
  let N = 0, cap = 0, srcLen = 0;
  let start, parent, match, type, aux, nlb;
  let stack = new Int32Array(64), tern = new Int32Array(64), sp = 1;
  let nl = true; // a line break precedes the next token (input start counts, for `-->`)
  let fnAt = -1, fnExpr = false; // the last `function` keyword token
  let fnBodyAt = -1, fnBodyExpr = false; // the `)` closing a function's parameters
  let classCand = -1, classCandExpr = false; // a `class` keyword awaiting its name / body
  const classAt = [], classIsExpr = []; // depths of class heads still waiting for their body (0/1: expression)

  function grow32(a, size) { const b = new Int32Array(size); b.set(a); return b; }
  function grow8(a, size) { const b = new Uint8Array(size); b.set(a); return b; }
  // Only very dense input (`;;;;`, `[0,1,0,...]`) outgrows the initial n/2 estimate: size the
  // arrays from the density so far rather than doubling, which would peak at 3x the need.
  function grow() {
    const seen = start[N - 1] + 1;
    const est = Math.ceil((N / seen) * srcLen * 1.05) + 64;
    cap = Math.min(Math.max(est, Math.ceil(cap * 1.25)), srcLen + 64);
    start = grow32(start, cap); parent = grow32(parent, cap); match = grow32(match, cap);
    type = grow8(type, cap); aux = grow8(aux, cap); nlb = grow8(nlb, cap);
  }

  // Bracket nesting deeper than this cannot be parsed by any engine (V8 gives up after a few
  // thousand levels), so such input is returned untouched instead of growing the stacks without
  // bound: 32 MB of `(` would otherwise cost about a gigabyte.
  const MAX_DEPTH = 1 << 18;
  const TOO_DEEP = new RangeError('nesting too deep');

  function release() {
    start = parent = match = type = aux = nlb = regexFail = null; // do not pin the last input's arrays
  }

  // Kept tiny so the optimizer inlines it at every call site.
  function push(t, s, a) {
    if (N === cap) grow();
    start[N] = s;
    type[N] = t;
    if (a !== 0) aux[N] = a;
    if (nl) { nlb[N] = 1; nl = false; }
    return N++;
  }

  // Does a `(` pushed now open the parameters of the last `function` (`function* name(`)?
  function opensFunctionParams() {
    const d = N - fnAt;
    if (fnAt < 0 || d > 3) return false;
    if (d === 1) return true;
    if (d === 2) return type[N - 1] === P_STAR || type[N - 1] === T_NAME;
    return type[N - 2] === P_STAR && type[N - 1] === T_NAME;
  }

  function open(idx) {
    if (sp === stack.length) {
      if (sp >= MAX_DEPTH) throw TOO_DEEP;
      const s2 = new Int32Array(sp * 2); s2.set(stack); stack = s2;
      const t2 = new Int32Array(sp * 2); t2.set(tern); tern = t2;
    }
    parent[idx] = stack[sp - 1];
    match[idx] = -1;
    stack[sp] = idx;
    tern[sp] = 0;
    sp++;
  }

  // Pop the innermost bracket for closing token idx; returns the opener or -1.
  function close(idx) {
    if (sp <= 1) { match[idx] = -1; return -1; }
    const o = stack[--sp];
    match[o] = idx;
    match[idx] = o;
    while (classAt.length && classAt[classAt.length - 1] > sp) { classAt.pop(); classIsExpr.pop(); }
    return o;
  }

  function ctxBraceKind() {
    const o = stack[sp - 1];
    if (o === -1) return B_BLOCK;
    return type[o] === P_LBRACE ? aux[o] : 0;
  }

  // Are we directly inside a statement list (top level, block or function body)?
  function inStatementList() {
    const k = ctxBraceKind();
    return k === B_BLOCK || k === B_FN || k === B_FN_EXPR;
  }

  // Is the `function` / `class` keyword about to be pushed an expression (acorn's f_expr)?
  function declIsExpr() {
    let p = N - 1;
    if (p >= 0 && type[p] === T_NAME && aux[p] === W_ASYNC && !nl) p--;
    if (p < 0) return false;
    const t = type[p];
    if (t === T_NAME) {
      const a = aux[p];
      if (a === W_RETURN || a === W_YIELD) return !(p + 1 < N ? nlb[p + 1] : nl);
      if (a === W_DEFAULT) return !(p > 0 && type[p - 1] === T_NAME && aux[p - 1] === W_EXPORT);
      return a !== W_ELSE && a !== W_DO && (WFLAG[a] & F_EXPR) !== 0;
    }
    if (t === P_SEMI || t === P_RBRACE || t === P_RPAREN || t === P_RBRACK || t === P_INCDEC) return false;
    if (t === P_LBRACE) return aux[p] === B_OBJECT;
    if (t === P_COLON) return aux[p] === COLON_TERNARY || !inStatementList();
    return t >= P_LBRACE || t === T_TMPL_HEAD || t === T_TMPL_MID;
  }

  // What does a `{` at this point open? (acorn's braceIsBlock, plus classes/functions/modules)
  function braceKind() {
    const p = N - 1;
    if (p < 0) return B_BLOCK;
    if (p === fnBodyAt) return fnBodyExpr ? B_FN_EXPR : B_FN;
    if (p === classCand) { classCand = -1; return classCandExpr ? B_CLASS_EXPR : B_CLASS; }
    if (classAt.length && classAt[classAt.length - 1] === sp) {
      classAt.pop();
      return classIsExpr.pop() ? B_CLASS_EXPR : B_CLASS;
    }
    switch (type[p]) {
      case P_ARROW: case P_RPAREN: case P_SEMI: case P_RBRACE: case P_LBRACE:
        return B_BLOCK;
      case P_COLON: {
        if (aux[p] === COLON_TERNARY) return B_OBJECT;
        return inStatementList() ? B_BLOCK : B_OBJECT; // label / case clause vs property value
      }
      case T_NAME: {
        const k = aux[p];
        // `catch {` is the optional catch binding (ES2019), which modern minifiers emit
        if (k === W_ELSE || k === W_TRY || k === W_FINALLY || k === W_DO || k === W_CATCH) return B_BLOCK;
        if (k === W_RETURN || k === W_YIELD) return nl ? B_BLOCK : B_OBJECT;
        if (k === W_IMPORT || k === W_EXPORT) return B_MODULE;
        if (k === W_STATIC) {
          const ck = ctxBraceKind();
          if (ck === B_CLASS || ck === B_CLASS_EXPR) return B_BLOCK; // static initialization block
        }
        if (k !== 0 && (WFLAG[k] & (F_EXPR | F_DECL)) !== 0) return B_OBJECT;
        return nl ? B_BLOCK : B_OBJECT;
      }
      case P_COMMA:
        // import def, { named } from '...'
        if (p >= 2 && type[p - 1] === T_NAME && type[p - 2] === T_NAME && aux[p - 2] === W_IMPORT) return B_MODULE;
        return B_OBJECT;
      case T_NUM: case T_STR: case T_TMPL: case T_TMPL_TAIL: case T_REGEX: case T_PRIVATE: case P_RBRACK: case P_INCDEC:
        return nl ? B_BLOCK : B_OBJECT;
      default:
        return B_OBJECT;
    }
  }

  function tokenize(src) {
    const n = src.length;
    N = 0;
    srcLen = n;
    cap = (n >> 1) + 64; // minified code runs ~0.45 tokens/char; untouched pages cost nothing
    start = new Int32Array(cap); parent = new Int32Array(cap); match = new Int32Array(cap);
    type = new Uint8Array(cap); aux = new Uint8Array(cap); nlb = new Uint8Array(cap);
    sp = 1;
    stack[0] = -1;
    nl = true;
    fnAt = -1; fnExpr = false; fnBodyAt = -1; fnBodyExpr = false;
    classCand = -1; classCandExpr = false; classAt.length = 0; classIsExpr.length = 0;
    regexFail = null;
    const hits = [];
    let exprAllowed = true; // a `/` here starts a regex
    let hasExport = false;

    let i = 0;
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) i = lineEnd(src, 2, n); // hashbang

    while (i < n) {
      const c = src.charCodeAt(i);
      const cls = c < 128 ? CHAR_CLASS[c] : isSpaceOrBreak(c) ? C_SPACE : C_IDENT;

      if (cls === C_SPACE) {
        if (c === 0x2028 || c === 0x2029) nl = true;
        i++;
        continue;
      }
      if (cls === C_BREAK) { nl = true; i++; continue; }

      // identifiers and keywords
      if (cls === C_IDENT) {
        const s = i;
        let h = 0, lower = true, esc = false;
        let d = c;
        for (;;) {
          if (d === 92) { // \uXXXX or \u{...}
            esc = true;
            lower = false;
            if (src.charCodeAt(i + 1) === 117) {
              if (src.charCodeAt(i + 2) === 123) { const e = src.indexOf('}', i + 3); i = e === -1 ? n : e + 1; }
              else i += 6;
            } else i++;
          } else {
            if (lower) {
              if (d >= 97 && d <= 122) h = (Math.imul(h, 31) + d) | 0;
              else lower = false;
            }
            i++;
          }
          if (i >= n) { i = n; break; }
          d = src.charCodeAt(i);
          if (d < 128 ? ID_PART[d] === 0 : isSpaceOrBreak(d)) break;
        }
        const len = i - s;
        let a = 0;
        if (lower) {
          if (len >= 2 && len <= 10) a = lookupWord(src, s, len, h);
        } else if (esc) {
          a = WORD_CODE.get(decodeIdent(src.slice(s, i))) || 0;
          if (a > W_EVAL) a = 0; // escaped keywords are not keywords
        }
        // After `.` / `?.` it is a property name, never a keyword.
        if (a > W_EVAL && N > 0 && (type[N - 1] === P_DOT || type[N - 1] === P_QDOT)) a = 0;
        if (classCand !== -1 && classCand === N - 1) {
          // `class Name ...` / `class extends ...`: the body is the next `{` at this depth.
          classAt.push(sp);
          classIsExpr.push(classCandExpr ? 1 : 0);
        }
        const declExpr = a === W_FUNCTION || a === W_CLASS ? declIsExpr() : false;
        const idx = push(T_NAME, s, a);
        if (a === 0) {
          exprAllowed = false;
        } else if (a <= W_EVAL) {
          parent[idx] = stack[sp - 1];
          hits.push(idx);
          exprAllowed = false;
        } else if (a === W_OF) {
          exprAllowed = !exprAllowed; // `for (x of /re/)`: `of` after an operand is an operator
        } else {
          exprAllowed = (WFLAG[a] & (F_EXPR | F_DECL)) !== 0; // after var/let/const a `[` opens a pattern
          if (a === W_FUNCTION) { fnAt = idx; fnExpr = declExpr; }
          else if (a === W_CLASS) { classCand = idx; classCandExpr = declExpr; }
          else if (a === W_EXPORT && sp === 1) hasExport = true;
        }
        continue;
      }

      // numbers
      if (cls === C_DIGIT || (c === 46 && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)) {
        const e = c === 46 ? scanNumber(src, i + 1, n, true) : scanNumber(src, i, n, false);
        push(T_NUM, i, 0);
        i = e;
        exprAllowed = false;
        continue;
      }

      // Punctuators, strings, templates, regexes: work out the token, then push it once.
      let t = P_OP, len = 1, a = 0, after = true, tmplOpen = -1;
      switch (c) {
        case 40: // (
          t = P_LPAREN;
          a = R_EXPR;
          if (opensFunctionParams()) {
            a = fnExpr ? R_FN_EXPR : R_FN;
          } else if (N > 0 && type[N - 1] === T_NAME) {
            const k = aux[N - 1];
            if (k === W_IF || k === W_WHILE || k === W_FOR || k === W_WITH) a = R_STMT;
            else if (k === W_AWAIT && N > 1 && type[N - 2] === T_NAME && aux[N - 2] === W_FOR) a = R_STMT;
          }
          break;
        case 41: // )
          t = P_RPAREN;
          break;
        case 91: // [ (aux 1: computed member access, never an array literal/pattern)
          t = P_LBRACK;
          a = exprAllowed ? 0 : 1;
          break;
        case 93: // ]
          t = P_RBRACK;
          after = false;
          break;
        case 123: // {
          t = P_LBRACE;
          a = braceKind();
          break;
        case 125: { // }
          const o = stack[sp - 1];
          if (o !== -1 && (type[o] === T_TMPL_HEAD || type[o] === T_TMPL_MID)) {
            // end of a `${...}` substitution: the template continues
            len = scanTemplate(src, i + 1, n) - i;
            if (tmplSubst) {
              t = T_TMPL_MID;
              tmplOpen = o;
              sp--;
            } else {
              t = T_TMPL_TAIL;
              after = false;
            }
          } else {
            t = P_RBRACE;
          }
          break;
        }
        case 59: // ;
          t = P_SEMI;
          if (classAt.length && classAt[classAt.length - 1] === sp) { classAt.pop(); classIsExpr.pop(); }
          break;
        case 44: // ,
          t = P_COMMA;
          break;
        case 58: // :
          t = P_COLON;
          if (tern[sp - 1] > 0) { tern[sp - 1]--; a = COLON_TERNARY; }
          break;
        case 63: { // ? ?. ?? ??=
          const d = src.charCodeAt(i + 1);
          if (d === 46 && !(src.charCodeAt(i + 2) >= 48 && src.charCodeAt(i + 2) <= 57)) {
            t = P_QDOT;
            len = 2;
            after = false;
          } else if (d === 63) {
            len = src.charCodeAt(i + 2) === 61 ? 3 : 2;
          } else {
            t = P_QUESTION;
            tern[sp - 1]++;
          }
          break;
        }
        case 46: // . ...
          if (src.charCodeAt(i + 1) === 46 && src.charCodeAt(i + 2) === 46) {
            t = P_ELLIPSIS;
            len = 3;
          } else {
            t = P_DOT;
            after = false;
          }
          break;
        case 61: { // = => == ===
          const d = src.charCodeAt(i + 1);
          if (d === 62) { t = P_ARROW; len = 2; }
          else if (d === 61) len = src.charCodeAt(i + 2) === 61 ? 3 : 2;
          else t = P_ASSIGN;
          break;
        }
        case 43: case 45: { // + - ++ -- += -=
          const d = src.charCodeAt(i + 1);
          if (d === c) {
            if (c === 45 && nl && src.charCodeAt(i + 2) === 62) { i = lineEnd(src, i + 3, n); continue; } // `-->` comment
            t = P_INCDEC; // operand-ness is unchanged: `a++ / b`, `++ /re/.x`
            len = 2;
            after = exprAllowed;
          } else if (d === 61) {
            len = 2;
          }
          break;
        }
        case 42: { // * ** *= **=
          const d = src.charCodeAt(i + 1);
          if (d === 42) len = src.charCodeAt(i + 2) === 61 ? 3 : 2;
          else if (d === 61) len = 2;
          else t = P_STAR;
          break;
        }
        case 47: { // / comments, regex, division
          const d = src.charCodeAt(i + 1);
          if (d === 47) { i = lineEnd(src, i + 2, n); continue; }
          if (d === 42) {
            const e = src.indexOf('*/', i + 2);
            const stop = e === -1 ? n : e + 2;
            if (!nl) {
              for (let k = i + 2; k < stop; k++) {
                if (isLineBreak(src.charCodeAt(k))) { nl = true; break; }
              }
            }
            i = stop;
            continue;
          }
          if (exprAllowed) {
            const e = scanRegex(src, i + 1, n);
            if (e !== -1) {
              t = T_REGEX;
              len = e - i;
              after = false;
              break;
            }
          }
          if (d === 61) len = 2;
          break;
        }
        case 34: case 39: // strings
          t = T_STR;
          len = scanString(src, i + 1, n, c) - i;
          after = false;
          break;
        case 96: // template literal
          len = scanTemplate(src, i + 1, n) - i;
          if (tmplSubst) t = T_TMPL_HEAD;
          else { t = T_TMPL; after = false; }
          break;
        case 60: // < << <= <<= and the `<!--` comment
          if (src.charCodeAt(i + 1) === 33 && src.charCodeAt(i + 2) === 45 && src.charCodeAt(i + 3) === 45) {
            i = lineEnd(src, i + 4, n);
            continue;
          }
          if (src.charCodeAt(i + 1) === 60) len = 2;
          if (src.charCodeAt(i + len) === 61) len++;
          break;
        case 62: // > >> >>> >= >>= >>>=
          while (len < 3 && src.charCodeAt(i + len) === 62) len++;
          if (src.charCodeAt(i + len) === 61) len++;
          break;
        case 33: // ! != !==
          if (src.charCodeAt(i + 1) === 61) len = src.charCodeAt(i + 2) === 61 ? 3 : 2;
          break;
        case 38: case 124: // & && &= &&= | || |= ||=
          if (src.charCodeAt(i + 1) === c) len = 2;
          if (src.charCodeAt(i + len) === 61) len++;
          break;
        case 37: case 94: // % %= ^ ^=
          if (src.charCodeAt(i + 1) === 61) len = 2;
          break;
        case 35: // #private
          t = T_PRIVATE;
          while (i + len < n && isIdPart(src.charCodeAt(i + len))) len++;
          after = false;
          break;
        case 64: // @decorator
          t = P_AT;
          break;
        default: // ~ and anything unexpected
          break;
      }

      const idx = push(t, i, a);
      i += len;
      switch (t) {
        case P_LPAREN: case P_LBRACK: case P_LBRACE: case T_TMPL_HEAD:
          open(idx);
          break;
        case T_TMPL_MID:
          match[tmplOpen] = idx;
          open(idx);
          break;
        case P_RPAREN: {
          const o = close(idx);
          const k = o >= 0 && type[o] === P_LPAREN ? aux[o] : R_EXPR;
          after = k === R_STMT;
          if (k === R_FN || k === R_FN_EXPR) { fnBodyAt = idx; fnBodyExpr = k === R_FN_EXPR; }
          break;
        }
        case P_RBRACK: case T_TMPL_TAIL:
          close(idx);
          break;
        case P_RBRACE: {
          const o = close(idx);
          after = o === -1 ? true : type[o] === P_LBRACE ? AFTER_BRACE[aux[o]] : false;
          break;
        }
      }
      exprAllowed = after;
    }

    const result = { N, start, type, aux, nlb, parent, match, hits, hasExport };
    release();
    return result;
  }

  // Exercises every tokenizer branch once. Run before the first large input so the optimizer
  // compiles the hot loop with complete type feedback instead of deoptimizing repeatedly.
  const PRIMER = [
    '#!/usr/bin/env node',
    '\'use strict\';"a\\"b\\\\\\\n";\'c\\\'d\';var a=0x1F+0o7+0b1+1_000+.5e-3+1n+2.,b=a/2/a,c=/[/\\]]+x\\/y/gi.test(`t${a+`u${{k:1}.k}`}v`)?a:b;',
    '// line', '/* block', '*/ <!-- html', '--> also a comment',
    'l:for(const x of /re/g.exec(s)||[])if(x)continue l;else break l;function* g(){yield /y/;yield* g()}',
    'async function h(){await /z/;for await(const q of g());}var\u00a0sp\u2028=1;',
    'class K extends(null??Object){#p=1;static s;static{this.s=2}get location(){return this.#p}set location(v){}*gen(){}async am(){}accessor z=1;[\'c\'](){}}',
    'const{location,eval:e2,...rest}=obj,[d1,,d2=3]=arr;({location}=o);x={location,get g(){},set g(v){},async*m(){},[k]:1,\'s\':2,1:3};',
    'let f=(p,{q},[r])=>({p}),f2=async p=>{p++;--p;p**=2;p??=1;p||=1;p&&=1;p>>>=1;p<<=1;p>>=1;p%=2;p^=1;p|=1;p&=1;p*=1;p-=1;p+=1;p/=2};',
    'switch(a){case 1:{a=~a;break}default:a=!a}try{throw new Error}catch({message}){}finally{}do a++;while(a<3)with(o){}',
    'if(a){}else if(b){}else{}var u=a?.b?.[c]?.(d),v=a?b:c,w=typeof a===\'x\'!==b,y=void 0,z=delete a.b,i1=a instanceof b,i2=\'a\'in b;',
    'x=a', '/b/c;x=a++/2;x=(a)/2;x=[a]/2;x=function(){}/2;x=class{}/2;\\u0061bc=1;\u00fcn\u00ef=2;a\\u{62}=3;',
    'x=location+eval(s)+obj.location+obj.eval(s)+\\u006cocation;@dec class D{}',
    'export default function(){}export{a as b};import c,{d as e}from\'m\';import*as f from\'m\';export*as location from\'m\';',
    '`a${`b${`c`}`}${d}${e}`;`$a\\`$${b}$`;if(a)/x/.test(b);return{}\nreturn\n{}\nyield\n{}',
    'n=[0,0.5,1e3,1E+3,3e-1,07,1_0.0_1,0n,.1,.5.toString(),1..x];x=1\n{}\n"s"\n{}\na[0]\n{}\n`t`\n{}\n/r/\n{}\na++\n{}\nx=typeof{};x=a in{};',
    'x=a?function(){}:function(){};o={k:function(){},c:class{}};q:function f1(){}return function(){};return\nfunction f2(){}',
    '!function(){}();[function(){},class{}];(class{});;class E{};x=[class{}]/2;x={}/1;x=(1)/2;export default class{}',
    'export const location=1,e3=2;export function location2(){}export async function*e4(){}export{location as l}from\'m\';',
    'import d0,{location as l2}from\'m\';for(x in y);while(0)/a/.test(b);',
  ].join('\n');
  let primed = false;

  /**
   * Pass 2: decide what each `location` / `eval` token needs and splice the edits in.
   * @param {string} src
   * @returns {string}
   */
  function rewriteJs(src) {
    if (typeof src !== 'string' || !src) return src;
    if (src.indexOf(NAME) === -1 && src.indexOf('eval') === -1 && src.indexOf('\\u') === -1) return src;
    if (!primed && src.length > 65536) {
      primed = true;
      // V8 allocates feedback vectors lazily, so the first calls of each helper record nothing.
      for (let k = 0; k < 3; k++) tokenize(PRIMER);
    }
    let tk;
    try {
      tk = tokenize(src);
    } catch (e) {
      if (e !== TOO_DEEP) throw e;
      release();
      return src; // nested deeper than any engine can parse: it cannot run anyway
    }
    if (tk.hits.length === 0) return src;
    const { N, start, type, aux, nlb, parent, match } = tk;

    // Edits as parallel arrays (an insertion has end === pos). Hits are handled in source order
    // and every edit lands at or after its hit, so these arrive sorted, except the `)` closing
    // `eval(__pRewriteJs(...`, which is kept apart and merged in at the end. Plain arrays of
    // numbers and shared strings keep hit-dense hostile input from costing an object per edit.
    let E = 0, epos = new Int32Array(64), eend = new Int32Array(64);
    const etext = [];
    const evalCloses = [];
    const edit = (pos, end, text) => {
      if (E === epos.length) { epos = grow32(epos, E * 2); eend = grow32(eend, E * 2); }
      epos[E] = pos;
      eend[E] = end;
      etext.push(text);
      E++;
    };
    let exportAlias = false;
    // Memo tables indexed by token (0: unknown, 1: no, 2: yes), allocated on first use.
    let patternMemo = null, declMemo = null, exportPatternMemo = null, restMemo = null;
    let heads = null; // template chunk -> its head token (built on first use)

    const isWord = (k, w) => k >= 0 && k < N && type[k] === T_NAME && aux[k] === w;
    const isDot = (k) => k >= 0 && (type[k] === P_DOT || type[k] === P_QDOT);
    const replace = (t, text) => edit(start[t], identEnd(src, start[t]), text);

    // Index of the head token of the template literal whose last chunk (T_TMPL_TAIL) is at k.
    // One forward pass replays the tokenizer's bracket stack, so this is O(1) per call even for
    // malformed input where counting heads and tails backwards would not pair them up.
    function templateHead(k) {
      if (heads === null) {
        heads = new Int32Array(N);
        const st = new Int32Array(N + 1);
        let top = 0;
        for (let j = 0; j < N; j++) {
          const ty = type[j];
          if (ty === P_LPAREN || ty === P_LBRACK || ty === P_LBRACE || ty === T_TMPL_HEAD) {
            heads[j] = j;
            st[top++] = j;
          } else if (ty === T_TMPL_MID || ty === T_TMPL_TAIL) {
            heads[j] = top > 0 ? heads[st[--top]] : 0;
            if (ty === T_TMPL_MID) { st[top++] = j; }
          } else if ((ty === P_RPAREN || ty === P_RBRACK || ty === P_RBRACE) && top > 0) {
            top--;
          }
        }
      }
      return heads[k];
    }

    // Does this token end an operand (so a line break after it may end a statement)?
    function endsOperand(k) {
      switch (type[k]) {
        case T_NAME: return aux[k] === 0 || aux[k] <= W_EVAL || (WFLAG[aux[k]] & F_EXPR) === 0;
        case T_NUM: case T_STR: case T_TMPL: case T_TMPL_TAIL: case T_REGEX: case T_PRIVATE:
        case P_RPAREN: case P_RBRACK: case P_RBRACE: case P_INCDEC:
          return true;
        default: return false;
      }
    }

    // `location` directly at property-name position of object literal/pattern `o`.
    function objectKeyPos(t, o) {
      let p = t - 1, mods = 0;
      while (p > o && mods < 2 && (type[p] === P_STAR ||
        (type[p] === T_NAME && (aux[p] === W_GET || aux[p] === W_SET || aux[p] === W_ASYNC)))) { p--; mods++; }
      if (p !== o && type[p] !== P_COMMA) return false;
      return mods === 0 || type[t + 1] === P_LPAREN; // get/set/async/* only prefix methods
    }

    // `location` naming a member of class body `o` (field, method, accessor).
    function classMemberPos(t, o) {
      const q = t + 1;
      if (q < N && type[q] === P_LPAREN && match[q] > 0 && match[q] + 1 < N && type[match[q] + 1] === P_LBRACE) return true;
      const p = t - 1;
      if (p === o) return true;
      const pt = type[p];
      if (pt === P_SEMI || pt === P_RBRACE) return true;
      if (pt === T_NAME && (aux[p] === W_STATIC || aux[p] === W_GET || aux[p] === W_SET || aux[p] === W_ASYNC || aux[p] === W_ACCESSOR)) {
        return !(q < N && type[q] === P_ARROW); // `x = async location => ...` is a parameter
      }
      // a generator method was recognised above by its `(...) {`; otherwise this is a product
      if (pt === P_STAR) return false;
      return nlb[t] === 1 && endsOperand(p); // after a field initializer ended by ASI
    }

    // Is paren `o` a parameter list (arrow, function, method, catch)?
    function isParamList(o) {
      const c = match[o];
      if (c < 0 || c + 1 >= N) return false;
      const nt = type[c + 1];
      if (nt === P_ARROW) return true;
      if (nt !== P_LBRACE) return false;
      if (aux[o] === R_STMT || aux[c + 1] === B_CLASS || aux[c + 1] === B_CLASS_EXPR) return false; // `extends f(...) {`
      return !isWord(o - 1, W_SWITCH);
    }

    // Is the `{` / `[` at token o a destructuring pattern rather than a literal? Nested brackets
    // inherit from their parent; resolved iteratively (and memoized) so deep nesting is cheap.
    const INHERIT = 2;
    function isPattern(o) {
      if (patternMemo === null) patternMemo = new Uint8Array(N);
      const chain = [];
      let r;
      for (;;) {
        if (patternMemo[o] !== 0) { r = patternMemo[o] === 2; break; }
        const v = ownPattern(o);
        if (v !== INHERIT) { r = v === 1; patternMemo[o] = r ? 2 : 1; break; }
        chain.push(o);
        o = parent[o];
      }
      for (const k of chain) patternMemo[k] = r ? 2 : 1;
      return r;
    }
    // 1: pattern, 0: literal, INHERIT: a pattern exactly when its parent bracket is one.
    function ownPattern(o) {
      const c = match[o];
      if (c < 0 || (type[o] === P_LBRACK && aux[o] === 1)) return 0;
      const nx = c + 1 < N ? c + 1 : -1;
      if (nx !== -1 && type[nx] === P_ASSIGN) return 1;
      const p = o - 1;
      if (p >= 0 && type[p] === T_NAME && (WFLAG[aux[p]] & F_DECL) !== 0) return 1;
      const par = parent[o];
      if (par < 0 || p < 0) return 0;
      const pt = type[par];
      if (pt === P_LPAREN) {
        if ((p === par || type[p] === P_COMMA || type[p] === P_ELLIPSIS) && isParamList(par)) return 1;
        // for ({ location } of list)
        return p === par && aux[par] === R_STMT && nx !== -1 && (isWord(nx, W_OF) || isWord(nx, W_IN)) ? 1 : 0;
      }
      if (pt === P_LBRACE) {
        return aux[par] === B_OBJECT && type[p] === P_COLON && aux[p] !== COLON_TERNARY ? INHERIT : 0;
      }
      if (pt === P_LBRACK) return p === par || type[p] === P_COMMA || type[p] === P_ELLIPSIS ? INHERIT : 0;
      return 0;
    }

    // Walk back over a top-level statement: is the `,` at k part of `export var/let/const ...`?
    // Every top-level comma passed on the way shares the answer, which keeps long comma
    // sequences linear.
    function inExportDeclaration(k) {
      if (declMemo === null) declMemo = new Uint8Array(N);
      const seen = [k];
      let r = false;
      for (k--; k >= 0; k--) {
        const ty = type[k];
        if (ty === P_RBRACE || ty === P_RPAREN || ty === P_RBRACK) {
          const o = match[k];
          if (o < 0 || (ty === P_RBRACE && aux[o] !== B_OBJECT)) break; // a block ends a statement
          k = o; // skip the bracketed tokens
          continue;
        }
        if (ty === P_COMMA) {
          if (declMemo[k] !== 0) { r = declMemo[k] === 2; break; }
          seen.push(k);
          continue;
        }
        if (ty === T_TMPL_TAIL) { k = templateHead(k); continue; }
        if (ty === P_SEMI || ty === P_LBRACE || ty === P_LPAREN || ty === P_LBRACK) break;
        if (ty === T_NAME && (WFLAG[aux[k]] & F_DECL) !== 0) { r = isWord(k - 1, W_EXPORT); break; }
        if (nlb[k + 1] === 1 && endsOperand(k) && (type[k + 1] === T_NAME || type[k + 1] === T_NUM ||
          type[k + 1] === T_STR || type[k + 1] === T_TMPL || type[k + 1] === T_TMPL_HEAD)) break; // ASI
      }
      for (const c of seen) declMemo[c] = r ? 2 : 1;
      return r;
    }

    // `location` declared by an `export` declaration: it must stay exported under its own name.
    function isExportedBinding(t) {
      const p = t - 1;
      if (p < 0) return false;
      if (type[p] === T_NAME) {
        const a = aux[p];
        if ((WFLAG[a] & F_DECL) !== 0 || a === W_CLASS) return isWord(p - 1, W_EXPORT);
        if (a === W_FUNCTION) return isWord(p - 1, W_EXPORT) || (isWord(p - 1, W_ASYNC) && isWord(p - 2, W_EXPORT));
        return false;
      }
      if (type[p] === P_STAR && isWord(p - 1, W_FUNCTION)) {
        return isWord(p - 2, W_EXPORT) || (isWord(p - 2, W_ASYNC) && isWord(p - 3, W_EXPORT));
      }
      if (type[p] === P_COMMA && parent[t] === -1) return inExportDeclaration(p);
      return false;
    }

    // `location` bound by a destructuring pattern that belongs to an `export` declaration.
    function isExportedPatternBinding(o) {
      if (exportPatternMemo === null) exportPatternMemo = new Uint8Array(N);
      const chain = [];
      let r;
      for (;;) {
        if (exportPatternMemo[o] !== 0) { r = exportPatternMemo[o] === 2; break; }
        const par = parent[o];
        if (par >= 0 && (type[par] === P_LBRACE || type[par] === P_LBRACK) && isPattern(par)) { chain.push(o); o = par; continue; }
        const p = o - 1;
        if (par !== -1 || p < 0) r = false;
        else if (type[p] === T_NAME && (WFLAG[aux[p]] & F_DECL) !== 0) r = isWord(p - 1, W_EXPORT);
        else r = type[p] === P_COMMA && inExportDeclaration(p);
        exportPatternMemo[o] = r ? 2 : 1;
        break;
      }
      for (const k of chain) exportPatternMemo[k] = r ? 2 : 1;
      return r;
    }

    // Does object pattern `o` end in `...rest`? Renaming a key there would change what the rest
    // object receives, so such patterns keep the real `location` key.
    // Memoized: a pattern may hold thousands of keys in front of one huge last element.
    function hasRestElement(o) {
      if (restMemo === null) restMemo = new Uint8Array(N);
      if (restMemo[o] !== 0) return restMemo[o] === 2;
      const c = match[o];
      let r = false;
      for (let k = c - 1; k > o; k--) {
        const ty = type[k];
        if (ty === P_RBRACE || ty === P_RPAREN || ty === P_RBRACK) { k = match[k] > o ? match[k] : k; continue; }
        if (ty === T_TMPL_TAIL) { k = Math.max(templateHead(k), o + 1); continue; }
        if (ty === P_ELLIPSIS) { r = true; break; }
        if (ty === P_COMMA) break; // the rest element must be last
      }
      restMemo[o] = r ? 2 : 1;
      return r;
    }

    const insert = (pos, text) => edit(pos, pos, text);
    const tokenText = (k) => src.slice(start[k], type[k] === T_STR ? scanString(src, start[k] + 1, src.length, src.charCodeAt(start[k])) : identEnd(src, start[k]));

    // Import/export specifiers. Imports keep the remote name and rename the local binding.
    // Every export named `location` also gets an `__pLocation` twin, because module namespace
    // objects have no prototype to supply the getter: `ns.location` becomes `ns.__pLocation`.
    function moduleSpecifier(t, o) {
      const p = t - 1, q = t + 1;
      if (isWord(o - 1, W_IMPORT) || type[o - 1] === P_COMMA) {
        if (isWord(q, W_AS)) return; // imported name
        if (isWord(p, W_AS)) replace(t, REPLACEMENT); // local binding
        else replace(t, NAME + ' as ' + REPLACEMENT);
        return;
      }
      const c = match[o];
      const reexport = c >= 0 && isWord(c + 1, W_FROM); // names on the left belong to the other module
      // Already rewritten (code can pass through twice, e.g. fetched by the server and then
      // evaluated through the client hook): the twin exists, and adding it again would be a
      // duplicate export. It sits in this list, or (for a local named __pLocation) comes from
      // the declaration that our export alias points at.
      const twin = !exportsReplacement(o);
      if (isWord(p, W_AS)) { // `x as location`: the exported name
        const local = p - 1;
        const text = !reexport && type[local] === T_NAME && aux[local] === W_LOCATION ? REPLACEMENT : tokenText(local);
        if (twin && (reexport || text !== REPLACEMENT || aux[local] === W_LOCATION)) {
          insert(identEnd(src, start[t]), ', ' + text + ' as ' + REPLACEMENT);
        }
        return;
      }
      if (isWord(q, W_AS)) { // `location as x`
        if (!reexport) replace(t, REPLACEMENT);
        return;
      }
      if (reexport) { if (twin) insert(identEnd(src, start[t]), ', ' + NAME + ' as ' + REPLACEMENT); }
      else replace(t, REPLACEMENT + ' as ' + NAME + (twin ? ', ' + REPLACEMENT : ''));
    }

    // Does export list `o` already export the name __pLocation?
    const replacementExports = new Map();
    const isReplacement = (k) => type[k] === T_NAME && aux[k] === 0 && src.startsWith(REPLACEMENT, start[k]) &&
      identEnd(src, start[k]) === start[k] + REPLACEMENT.length;
    function exportsReplacement(o) {
      let r = replacementExports.get(o);
      if (r === undefined) {
        r = false;
        for (let k = o + 1, c = match[o]; k < c; k++) {
          if (isReplacement(k) && (isWord(k - 1, W_AS) || !isWord(k + 1, W_AS))) { r = true; break; }
        }
        replacementExports.set(o, r);
      }
      return r;
    }

    function handleLocation(t) {
      const p = t - 1, q = t + 1;
      if (isDot(p)) {
        // super.location must keep reading the parent class's member, not this.location
        if (!isWord(p - 1, W_SUPER)) replace(t, REPLACEMENT);
        return;
      }
      const o = parent[t];
      if (o >= 0 && type[o] === P_LBRACE) {
        const k = aux[o];
        if (k === B_OBJECT) {
          const qt = q < N ? type[q] : 0;
          if (objectKeyPos(t, o)) {
            if (qt === P_COLON) { // `{ location: v }`
              if (isPattern(o) && !hasRestElement(o)) replace(t, REPLACEMENT);
              return;
            }
            if (qt === P_LPAREN) return; // method
            if (qt === P_COMMA || q === match[o] || qt === P_ASSIGN) { // shorthand
              const pattern = isPattern(o);
              if (pattern && !hasRestElement(o)) replace(t, REPLACEMENT);
              else replace(t, NAME + ':' + REPLACEMENT);
              if (pattern && tk.hasExport && isExportedPatternBinding(o)) exportAlias = true;
              return;
            }
          } else if (tk.hasExport && (qt === P_COMMA || q === match[o] || qt === P_ASSIGN) &&
            ((type[p] === P_COLON && aux[p] !== COLON_TERNARY) || type[p] === P_ELLIPSIS) && isPattern(o) && isExportedPatternBinding(o)) {
            exportAlias = true; // `export const { a: location } = ...`
          }
          replace(t, REPLACEMENT);
          return;
        }
        if (k === B_CLASS || k === B_CLASS_EXPR) {
          if (!classMemberPos(t, o)) replace(t, REPLACEMENT);
          return;
        }
        if (k === B_MODULE) {
          moduleSpecifier(t, o);
          return;
        }
      } else if (o >= 0 && type[o] === P_LBRACK && tk.hasExport && (p === o || type[p] === P_COMMA || type[p] === P_ELLIPSIS) &&
        (q === match[o] || type[q] === P_COMMA || type[q] === P_ASSIGN) && isPattern(o) && isExportedPatternBinding(o)) {
        exportAlias = true; // `export const [location] = ...`
      }
      // `export * as location from '...'` names an export, not a binding
      if (isWord(p, W_AS) && type[p - 1] === P_STAR && isWord(p - 2, W_EXPORT)) return;
      replace(t, REPLACEMENT);
      if (tk.hasExport && o === -1 && isExportedBinding(t)) exportAlias = true;
    }

    function handleEval(t) {
      const q = t + 1;
      if (q >= N || type[q] !== P_LPAREN) return;
      const p = t - 1;
      if (isDot(p) || isWord(p, W_FUNCTION) || isWord(p, W_NEW)) return;
      const c = match[q];
      if (c < 0 || c === q + 1) return; // unbalanced / `eval()`
      if (c + 1 < N && type[c + 1] === P_LBRACE) return; // method definition `eval(x) { ... }`
      if (type[q + 1] === T_NAME && src.startsWith(EVAL_HOOK, start[q + 1]) && identEnd(src, start[q + 1]) === start[q + 1] + EVAL_HOOK.length) return; // already rewritten
      const o = parent[t];
      if (o >= 0 && type[o] === P_LBRACE) {
        if (aux[o] === B_OBJECT && objectKeyPos(t, o)) return;
        if ((aux[o] === B_CLASS || aux[o] === B_CLASS_EXPR) && classMemberPos(t, o)) return;
      }
      insert(start[q] + 1, EVAL_HOOK + '(');
      evalCloses.push(start[c]);
    }

    for (const t of tk.hits) {
      if (aux[t] === W_EVAL) handleEval(t);
      else handleLocation(t);
    }
    if (E === 0) return src;
    // Nested evals close in reverse order: sort those positions (numerically) and merge.
    const closes = Int32Array.from(evalCloses).sort();
    const C = closes.length;

    // Joined in chunks so the pieces of a hit-dense input do not all stay alive at once.
    const chunks = [];
    let out = [];
    let last = 0;
    for (let i = 0, j = 0; i < E || j < C;) {
      let pos, end, text;
      if (j < C && (i === E || closes[j] < epos[i])) { pos = end = closes[j++]; text = ')'; }
      else { pos = epos[i]; end = eend[i]; text = etext[i]; i++; }
      out.push(src.slice(last, pos), text);
      last = end;
      if (out.length >= 8192) { chunks.push(out.join('')); out = []; }
    }
    out.push(src.slice(last));
    // An exported declaration was renamed: keep exporting it under its original name too.
    if (exportAlias) out.push('\n;export{' + REPLACEMENT + ' as ' + NAME + '};');
    chunks.push(out.join(''));
    return chunks.length === 1 ? chunks[0] : chunks.join('');
  }

  /**
   * Where the guard can go: after a hashbang and the directive prologue ("use strict" must stay
   * first to keep its effect). Returns [index, needsSemicolon].
   */
  function prologueEnd(src) {
    const n = src.length;
    let i = 0;
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) i = lineEnd(src, 2, n);
    let pos = i, semi = false;
    const skip = (k) => {
      let brk = false;
      for (;;) {
        const c = src.charCodeAt(k);
        if (c === 32 || c === 9 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff) k++;
        else if (isLineBreak(c)) { brk = true; k++; }
        else if (c === 47 && src.charCodeAt(k + 1) === 47) k = lineEnd(src, k + 2, n);
        else if (c === 47 && src.charCodeAt(k + 1) === 42) {
          const e = src.indexOf('*/', k + 2);
          const stop = e === -1 ? n : e + 2;
          for (let j = k; j < stop; j++) if (isLineBreak(src.charCodeAt(j))) { brk = true; break; }
          k = stop;
        } else return [k, brk];
      }
    };
    for (;;) {
      const [s] = skip(i);
      const q = src.charCodeAt(s);
      if (q !== 34 && q !== 39) break;
      const e = scanString(src, s + 1, n, q);
      if (src.charCodeAt(e - 1) !== q) break;
      const [k, brk] = skip(e);
      const c = src.charCodeAt(k);
      if (c === 59) { pos = i = k + 1; semi = false; continue; }
      // ASI ends the directive only if the next line cannot continue the expression
      if (k >= n || c === 125 || (brk && !/[.,[(+\-*/%<>=&|^?`!~:]|in(?:stanceof)?\b/y.test(src.slice(k, k + 11)))) {
        pos = i = e;
        semi = true;
        continue;
      }
      break;
    }
    return [pos, semi];
  }

  function withGuard(src) {
    const [i, semi] = prologueEnd(src);
    if (src.startsWith(GUARD, i) || src.startsWith(GUARD, i + 1)) return src;
    return src.slice(0, i) + (semi ? ';' : '') + GUARD + src.slice(i);
  }

  /** Rewrite a standalone script / module / worker and prepend the guard if anything changed. */
  function rewriteScript(src, opts) {
    const out = rewriteJs(src);
    if (out === src || (opts && opts.guard === false)) return out;
    return withGuard(out);
  }

  return { rewriteJs, rewriteScript, GUARD, REPLACEMENT, EVAL_HOOK };
});
