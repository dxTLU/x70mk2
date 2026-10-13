'use strict';

/*
 * Lightweight JavaScript rewriter.
 *
 * Pages read `location` / `window.location` to learn where they are. Under the proxy the real
 * location is /p/https://site/..., which confuses routers and URL builders. We rename every
 * `location` identifier (bare or as a property) to `__pLocation`. The browser runtime defines
 * `Object.prototype.__pLocation`, which returns a virtual Location for windows/documents and
 * falls through to the ordinary `.location` property for any other object, so renaming is
 * safe for unrelated objects that happen to have a `location` field.
 *
 * A real tokenizer (strings, template literals, comments, regex literals) makes sure only
 * code is touched.
 */

const NAME = 'location';
const REPLACEMENT = '__pLocation';

const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do',
  'else', 'yield', 'await', 'extends',
]);

// Prepended to standalone scripts so `__pLocation` exists even where the runtime is absent (workers).
const GUARD =
  'if(!Object.prototype.hasOwnProperty("__pLocation"))Object.defineProperty(Object.prototype,"__pLocation",' +
  '{configurable:true,get:function(){return this.location},set:function(v){this.location=v}});';

function isIdentChar(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 36 || c === 95 || c > 127 || c === 92;
}

function isIdentStart(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95 || c > 127 || c === 92;
}

/**
 * @param {string} src
 * @returns {string}
 */
function rewriteJs(src) {
  if (!src || src.indexOf(NAME) === -1) return src;
  const n = src.length;
  const out = [];
  let last = 0; // start of not-yet-emitted source
  let i = 0;
  // 'tok' kinds: 'start' | 'ident' | 'kw' | 'num' | 'str' | 'punc' | 'close' | 'regexOk'
  let prevKind = 'start';
  let prevValue = '';
  let prevSig = -1; // index of last significant char
  const stack = []; // '{', '(', '[', '`'

  const readTemplate = () => {
    // i is positioned just after '`' or after '}' that closes ${...}
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 92) { i += 2; continue; }
      if (c === 96) { i++; prevKind = 'str'; return; }
      if (c === 36 && src.charCodeAt(i + 1) === 123) {
        i += 2;
        stack.push('`');
        prevKind = 'punc';
        prevValue = '{';
        return;
      }
      i++;
    }
  };

  while (i < n) {
    const c = src.charCodeAt(i);

    // whitespace
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029) { i++; continue; }

    // comments
    if (c === 47) {
      const d = src.charCodeAt(i + 1);
      if (d === 47) { const e = src.indexOf('\n', i + 2); i = e === -1 ? n : e + 1; continue; }
      if (d === 42) { const e = src.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
      // regex or division?
      const regexAllowed = prevKind === 'start' || prevKind === 'punc' || prevKind === 'kw' || (prevKind === 'close' && prevValue === '}');
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const r = src.charCodeAt(j);
          if (r === 92) { j += 2; continue; }
          if (r === 10 || r === 13) break; // not a regex after all
          if (inClass) { if (r === 93) inClass = false; }
          else if (r === 91) inClass = true;
          else if (r === 47) break;
          j++;
        }
        if (j < n && src.charCodeAt(j) === 47) {
          j++;
          while (j < n && isIdentChar(src.charCodeAt(j))) j++;
          i = j;
          prevKind = 'num'; // a regex literal behaves like an operand
          prevSig = i - 1;
          continue;
        }
      }
      i++;
      prevKind = 'punc';
      prevValue = '/';
      prevSig = i - 1;
      continue;
    }

    // strings
    if (c === 34 || c === 39) {
      let j = i + 1;
      while (j < n) {
        const s = src.charCodeAt(j);
        if (s === 92) { j += 2; continue; }
        if (s === c || s === 10) break;
        j++;
      }
      i = j + 1;
      prevKind = 'str';
      prevSig = i - 1;
      continue;
    }

    // template literal
    if (c === 96) {
      i++;
      readTemplate();
      prevSig = i - 1;
      continue;
    }

    // identifiers / keywords
    if (isIdentStart(c)) {
      const start = i;
      i++;
      while (i < n && isIdentChar(src.charCodeAt(i))) i++;
      const word = src.slice(start, i);
      if (word === NAME) {
        const before = prevSig >= 0 ? src.charCodeAt(prevSig) : -1;
        const isPrivate = start > 0 && src.charCodeAt(start - 1) === 35; // #location
        if (!isPrivate) {
          let k = i;
          while (k < n && /\s/.test(src[k])) k++;
          const after = k < n ? src.charCodeAt(k) : -1;
          const top = stack[stack.length - 1];
          const isMember = before === 46 && !(prevSig >= 2 && src.charCodeAt(prevSig - 1) === 46 && src.charCodeAt(prevSig - 2) === 46);
          const keyPosition = (before === 123 || before === 44) && top === '{';
          if (isMember) {
            out.push(src.slice(last, start), REPLACEMENT);
            last = i;
          } else if (keyPosition && after === 58) {
            // { location: ... } object key: leave alone
          } else if (keyPosition && (after === 44 || after === 125)) {
            // shorthand { location } -> { location: __pLocation }
            out.push(src.slice(last, start), NAME + ':' + REPLACEMENT);
            last = i;
          } else {
            out.push(src.slice(last, start), REPLACEMENT);
            last = i;
          }
        }
      }
      prevKind = REGEX_KEYWORDS.has(word) ? 'kw' : 'ident';
      prevValue = word;
      prevSig = i - 1;
      continue;
    }

    // numbers
    if (c >= 48 && c <= 57) {
      i++;
      while (i < n && (isIdentChar(src.charCodeAt(i)) || src.charCodeAt(i) === 46)) i++;
      prevKind = 'num';
      prevSig = i - 1;
      continue;
    }

    // punctuation
    if (c === 123 || c === 40 || c === 91) {
      stack.push(String.fromCharCode(c));
      prevKind = 'punc';
      prevValue = String.fromCharCode(c);
      i++;
      prevSig = i - 1;
      continue;
    }
    if (c === 125) {
      const top = stack.pop();
      if (top === '`') {
        i++;
        readTemplate();
        prevSig = i - 1;
        continue;
      }
      prevKind = 'close';
      prevValue = '}';
      i++;
      prevSig = i - 1;
      continue;
    }
    if (c === 41 || c === 93) {
      stack.pop();
      prevKind = 'close';
      prevValue = String.fromCharCode(c);
      i++;
      prevSig = i - 1;
      continue;
    }
    // `++` / `--` after an operand keep it an operand (a++ / b) — treat as close.
    if ((c === 43 || c === 45) && src.charCodeAt(i + 1) === c && (prevKind === 'ident' || prevKind === 'close' || prevKind === 'num')) {
      i += 2;
      prevKind = 'close';
      prevValue = ')';
      prevSig = i - 1;
      continue;
    }
    prevKind = 'punc';
    prevValue = String.fromCharCode(c);
    i++;
    prevSig = i - 1;
  }

  if (last === 0) return src;
  out.push(src.slice(last));
  return out.join('');
}

/** Insert the guard after any directive prologue ("use strict") and hashbang. */
function withGuard(src) {
  let i = 0;
  if (src.startsWith('#!')) { const e = src.indexOf('\n'); i = e === -1 ? src.length : e + 1; }
  const re = /\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*\s*(["'])use strict\1\s*;?/y;
  re.lastIndex = i;
  const m = re.exec(src);
  if (m) i = re.lastIndex;
  return src.slice(0, i) + GUARD + src.slice(i);
}

function rewriteScript(src, { guard = true } = {}) {
  const out = rewriteJs(src);
  if (out === src || !guard) return out;
  return withGuard(out);
}

module.exports = { rewriteJs, rewriteScript, GUARD, REPLACEMENT };
