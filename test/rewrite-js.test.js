'use strict';

// Unit, regression, semantic and performance tests for src/rewrite-js.js. No network needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'src', 'rewrite-js.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'js');
const { rewriteJs, rewriteScript, GUARD, REPLACEMENT, EVAL_HOOK } = require(SRC);

const ALIAS = '\n;export{__pLocation as location};';

// Values from another realm fail strict deep-equality on their prototypes: copy them out as JSON.
const read = (ctx, expr) => JSON.parse(vm.runInContext('JSON.stringify(' + expr + ')', ctx));

// --- syntax checks -------------------------------------------------------------------------

function scriptError(code, mode) {
  try {
    if (mode === 'body') vm.compileFunction(code);
    else new vm.Script(code);
    return null;
  } catch (e) {
    return e.message;
  }
}

// vm.SourceTextModule needs --experimental-vm-modules, so module work runs in one child process.
const CHILD = `
'use strict';
const vm = require('vm');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  const job = JSON.parse(input);
  const R = require(job.rewriter);
  const describe = (v) => {
    if (typeof v === 'function') return 'fn:' + v.name;
    if (v && typeof v === 'object' && v[Symbol.toStringTag] === 'Module') return 'ns:' + Object.keys(v).filter((k) => k !== '__pLocation').join();
    return JSON.stringify(v);
  };
  const out = [];
  for (const task of job.tasks) {
    try {
      if (task.kind === 'parse') {
        new vm.SourceTextModule(task.source);
        out.push({ ok: true });
        continue;
      }
      const ctx = vm.createContext({});
      vm.runInContext(task.prelude || '', ctx);
      ctx.__pRewriteJs = (s) => (typeof s === 'string' ? R.rewriteJs(s) : s);
      const mods = {};
      for (const [spec, source] of Object.entries(task.modules)) {
        mods[spec] = new vm.SourceTextModule(source, { context: ctx, identifier: 'file:///' + spec, importModuleDynamically: (s) => mods[s] });
      }
      await mods[task.entry].link((spec) => mods[spec]);
      await mods[task.entry].evaluate();
      const ns = mods[task.entry].namespace;
      const view = {};
      for (const k of Object.keys(ns).sort()) if (k !== '__pLocation') view[k] = describe(ns[k]);
      out.push({ ok: true, view });
    } catch (e) {
      out.push({ ok: false, error: String((e && e.stack) || e) });
    }
  }
  process.stdout.write(JSON.stringify(out));
});
`;

function runChild(tasks) {
  const env = { ...process.env };
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'UPSTREAM_PROXY', 'NODE_OPTIONS']) delete env[k];
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', CHILD], {
    input: JSON.stringify({ rewriter: SRC, tasks }),
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, 'module child failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}

function moduleErrors(sources) {
  return runChild(sources.map((source) => ({ kind: 'parse', source }))).map((r) => (r.ok ? null : r.error.split('\n')[0]));
}

// --- table-driven unit cases ---------------------------------------------------------------
// [input, expected output, mode]; mode: 'script' (default), 'module', 'body' (function body) or
// 'loose' (syntax V8 does not ship yet, so only the output text is checked).

const same = (s, mode) => [s, s, mode];

const CASES = {
  'regex vs division': [
    ['a = b / location / c', 'a = b / __pLocation / c'],
    same('x = /location/.test(y)'),
    ['x = /location/g.exec(y) / location', 'x = /location/g.exec(y) / __pLocation'],
    same('if (a) /location/.test(b)'),
    same('while (a) /location/.test(b)'),
    same('for (;;) /location/.test(b)'),
    same('if (a) {} else /location/.test(s)'),
    same('do /location/.test(s); while (0)'),
    ['x = (a) / location / 2', 'x = (a) / __pLocation / 2'],
    ['x = a[0] / location / 2', 'x = a[0] / __pLocation / 2'],
    ['x = {} / location', 'x = {} / __pLocation'],
    ['x = a++ / location', 'x = a++ / __pLocation'],
    ['x = a-- / location', 'x = a-- / __pLocation'],
    ['x = ++a / location', 'x = ++a / __pLocation'],
    ['x = a.return / location', 'x = a.return / __pLocation'],
    ['x = a?.if / location', 'x = a?.if / __pLocation'],
    ['x = y.default / location', 'x = y.default / __pLocation'],
    ['x = this / location + null / location', 'x = this / __pLocation + null / __pLocation'],
    ['x = 1.5 / location + "s" / location + /r/ / location', 'x = 1.5 / __pLocation + "s" / __pLocation + /r/ / __pLocation'],
    same('x = typeof /location/ + void /location/'),
    same('throw /location/'),
    same('x = a ? /location/ : /location/'),
    same('x = a in /location/'),
    same('x = [/location/, { a: /location/ }, !/location/.test(s)]'),
    same('x = /[/location]/.test(s)'),
    same('x = /a\\/location/'),
    same('x = /[\\]/location]/'),
    same('x = /=location/'),
    ['a /= location', 'a /= __pLocation'],
    same('function f() {}\n/location/.test(s)'),
    ['x = function () {} / location', 'x = function () {} / __pLocation'],
    ['x = class {} / location', 'x = class {} / __pLocation'],
    same('class A {}\n/location/.test(s)'),
    same('x = () => {}\n/location/.test(s)'),
    same('label: { /location/.test(s) }'),
    ['x = a\n/location/g.exec(c)', 'x = a\n/__pLocation/g.exec(c)'], // no ASI: this is division
    ['x = `${a}` / location', 'x = `${a}` / __pLocation'],
    ['x = `${a}${b}` / location', 'x = `${a}${b}` / __pLocation'],
    same('async function f() { await /location/.exec(s) }'),
    same('function* g() { yield /location/ }'),
    same('for (const x of /location/g.exec(s)) {}'),
    ['x = a in b / location', 'x = a in b / __pLocation'],
    same('switch (a) { case /location/.source: }'),
    ['x = a\n++location', 'x = a\n++__pLocation'],
    same('return /location/', 'body'),
    ['x = a ? b : c / location', 'x = a ? b : c / __pLocation'],
  ],

  'template literals': [
    ['`location ${location}`', '`location ${__pLocation}`'],
    ['`${location}${location}${location}`', '`${__pLocation}${__pLocation}${__pLocation}`'],
    ['`${`${`${location}`}`}`', '`${`${`${__pLocation}`}`}`'],
    ['`${ {location} }`', '`${ {location:__pLocation} }`'],
    ['`${ "}" + location }`', '`${ "}" + __pLocation }`'],
    ['`${ f({ a: `}` }) + location }`', '`${ f({ a: `}` }) + __pLocation }`'],
    same('`\\${location}`'),
    same('`$location {location}`'),
    ['tag`a${location}b`', 'tag`a${__pLocation}b`'],
    ['`${a}` + location', '`${a}` + __pLocation'],
    ['`${function () { return { location } }()}`', '`${function () { return { location:__pLocation } }()}`'],
    ['`${/location/.source}${location}`', '`${/location/.source}${__pLocation}`'],
    same('`${a}/location/${b}`'),
    ['x = `\n${location}\n`', 'x = `\n${__pLocation}\n`'],
    ['x = `${a}` + `${location}`', 'x = `${a}` + `${__pLocation}`'],
  ],

  'comments, strings, HTML comments, hashbang': [
    ['location /* location */ . /* location */ href // location', '__pLocation /* location */ . /* location */ href // location'],
    ['a = b /* x */ / location', 'a = b /* x */ / __pLocation'],
    same('a = /* x */ /location/'),
    ['a = b // c\n/ location', 'a = b // c\n/ __pLocation'],
    ['<!-- location\nx = location\n--> location', '<!-- location\nx = __pLocation\n--> location'],
    ['x = a-->location', 'x = a-->__pLocation'],
    ['x = 1;\n  --> comment location\nlocation', 'x = 1;\n  --> comment location\n__pLocation'],
    ['/* a\n */ --> location\nlocation', '/* a\n */ --> location\n__pLocation'],
    ['#!/usr/bin/env node location\nlocation', '#!/usr/bin/env node location\n__pLocation'],
    ['"location" + location', '"location" + __pLocation'],
    ["'it\\'s location' + location", "'it\\'s location' + __pLocation"],
    ['"a\\\\" + location', '"a\\\\" + __pLocation'],
    ["'a\\\nlocation' + location", "'a\\\nlocation' + __pLocation"],
    ["'a\\\r\nlocation' + location", "'a\\\r\nlocation' + __pLocation"],
    ['" location" + location', '" location" + __pLocation'],
  ],

  'member access, optional chaining, spread, private names, super': [
    ['window.location.href', 'window.__pLocation.href'],
    ['a.location.location', 'a.__pLocation.__pLocation'],
    ['a?.location', 'a?.__pLocation'],
    ['a?.[location]', 'a?.[__pLocation]'],
    ['a?.location?.()', 'a?.__pLocation?.()'],
    ['a. location', 'a. __pLocation'],
    ['a\n.location', 'a\n.__pLocation'],
    ['a /* c */ .location', 'a /* c */ .__pLocation'],
    ['1..location', '1..__pLocation'],
    ['x = .5.location + 1.5.location + .5e1.location + 0x1.location + 1e3.location', 'x = .5.__pLocation + 1.5.__pLocation + .5e1.__pLocation + 0x1.__pLocation + 1e3.__pLocation'],
    same('x = .5.eval(y) + 2..eval(z)'),
    ['x = a?.5:location', 'x = a?.5:__pLocation'],
    ['f(...location)', 'f(...__pLocation)'],
    ['x = [...location]', 'x = [...__pLocation]'],
    ['x = {...location}', 'x = {...__pLocation}'],
    same('class A { #location = 1; m() { return this.#location + (#location in this) } }'),
    same('class B extends A { m() { return super.location + super["location"] + super.location.href } }'),
    ['this.location = x', 'this.__pLocation = x'],
    ['new.target.location', 'new.target.__pLocation', 'body'],
    ['typeof location', 'typeof __pLocation'],
    ['delete location.hash', 'delete __pLocation.hash'],
    same("'location' in window"),
    ['location in window', '__pLocation in window'],
    ['javascript:void(location.href=\'/x\')', 'javascript:void(__pLocation.href=\'/x\')'],
  ],

  'object literals': [
    ['x = {location: location}', 'x = {location: __pLocation}'],
    ['x = {location}', 'x = {location:__pLocation}'],
    ['x = {a, location, b}', 'x = {a, location:__pLocation, b}'],
    ['x = { location }', 'x = { location:__pLocation }'],
    ["x = {'location': 1, \"location\": location, [location]: 1, 1: location}", "x = {'location': 1, \"location\": __pLocation, [__pLocation]: 1, 1: __pLocation}"],
    ['x = {location() { return location }}', 'x = {location() { return __pLocation }}'],
    same('x = {get location() { return 1 }, set location(v) {}, async location() {}, *location() {}, async *location() {}}'),
    ['x = {get: location, set: location, async: location}', 'x = {get: __pLocation, set: __pLocation, async: __pLocation}'],
    ['x = {get, location}', 'x = {get, location:__pLocation}'],
    ['x = {a: b ? location : c}', 'x = {a: b ? __pLocation : c}'],
    ['x = {a: {location}}', 'x = {a: {location:__pLocation}}'],
    ['f = () => ({location})', 'f = () => ({location:__pLocation})'],
    ['a ? {location} : b', 'a ? {location:__pLocation} : b'],
    ['x = a ? b : {location}', 'x = a ? b : {location:__pLocation}'],
    ['x = [{location}]', 'x = [{location:__pLocation}]'],
    ['f({location})', 'f({location:__pLocation})'],
    ['return {location}', 'return {location:__pLocation}', 'body'],
    ['return\n{location}', 'return\n{__pLocation}', 'body'],
    ['switch (a) { case 1: x = {location}; }', 'switch (a) { case 1: x = {location:__pLocation}; }'],
    ['function f(a = {location}) {}', 'function f(a = {location:__pLocation}) {}'],
    ['x = {location, ...rest}', 'x = {location:__pLocation, ...rest}'],
    ['x = {[location]: location}', 'x = {[__pLocation]: __pLocation}'],
    ['x = {location: {location}}', 'x = {location: {location:__pLocation}}'],
    ['x = {location\n}', 'x = {location:__pLocation\n}'],
    ['x = { location /* c */ }', 'x = { location:__pLocation /* c */ }'],
    ['x = {location, }', 'x = {location:__pLocation, }'],
    ['x = {if: location, location: 1}', 'x = {if: __pLocation, location: 1}'],
  ],

  'blocks, labels, statements': [
    ['{ location }', '{ __pLocation }'],
    ['if (a) { location = 1 }', 'if (a) { __pLocation = 1 }'],
    ['location: for (;;) { break location; continue location }', '__pLocation: for (;;) { break __pLocation; continue __pLocation }'],
    ['function f() { a: { location: { break location } } }', 'function f() { a: { __pLocation: { break __pLocation } } }'],
    ['function f() { a: { b: { c: location } } }', 'function f() { a: { b: { c: __pLocation } } }'],
    ['do { location } while (0)', 'do { __pLocation } while (0)'],
    ['try { location } catch (e) { location } finally { location }', 'try { __pLocation } catch (e) { __pLocation } finally { __pLocation }'],
    ['switch (x) { case location: break; default: location }', 'switch (x) { case __pLocation: break; default: __pLocation }'],
    ['x = a ? location : b', 'x = a ? __pLocation : b'],
    ['while (location) {}', 'while (__pLocation) {}'],
    ['for (location in o) {}', 'for (__pLocation in o) {}'],
    ['for (const location of xs) location', 'for (const __pLocation of xs) __pLocation'],
    ['{ location: 1 }', '{ __pLocation: 1 }'],
    ['f = () => { location }', 'f = () => { __pLocation }'],
    ['if (a) {} else { location }', 'if (a) {} else { __pLocation }'],
    ['with (o) { location }', 'with (o) { __pLocation }'],
    ['x = y\n{location}', 'x = y\n{__pLocation}'],
  ],

  'destructuring': [
    ['const {location} = window', 'const {__pLocation} = window'],
    ['const {location: loc} = window', 'const {__pLocation: loc} = window'],
    ['const {location = 1} = o', 'const {__pLocation = 1} = o'],
    ['let {a: {location}} = o', 'let {a: {__pLocation}} = o'],
    ['var [{location}] = o', 'var [{__pLocation}] = o'],
    ['const [location] = o', 'const [__pLocation] = o'],
    ['let [, {location}] = o', 'let [, {__pLocation}] = o'],
    ['({location} = o)', '({__pLocation} = o)'],
    ['[{location}] = o', '[{__pLocation}] = o'],
    ['[a, {location}] = o', '[a, {__pLocation}] = o'],
    ['function f({location}) {}', 'function f({__pLocation}) {}'],
    ['f = ({location}) => location', 'f = ({__pLocation}) => __pLocation'],
    ['f = async ({location}) => 1', 'f = async ({__pLocation}) => 1'],
    ['f = (a, {location}) => 1', 'f = (a, {__pLocation}) => 1'],
    ['function f({location} = {}) {}', 'function f({__pLocation} = {}) {}'],
    ['function f([{location}]) {}', 'function f([{__pLocation}]) {}'],
    ['for (const {location} of xs) {}', 'for (const {__pLocation} of xs) {}'],
    ['for ({location} of xs);', 'for ({__pLocation} of xs);'],
    ['for (const {location} in xs) {}', 'for (const {__pLocation} in xs) {}'],
    ['for (const [location, {location: b}] of m) {}', 'for (const [__pLocation, {__pLocation: b}] of m) {}'],
    ['try {} catch ({location}) {}', 'try {} catch ({__pLocation}) {}'],
    ['const {a = {location}} = o', 'const {a = {location:__pLocation}} = o'],
    ['const {[location]: x} = o', 'const {[__pLocation]: x} = o'],
    ['const {...location} = o', 'const {...__pLocation} = o'],
    // a rest element must keep excluding the real key
    ['const {location, ...rest} = o', 'const {location:__pLocation, ...rest} = o'],
    same('const {location: l, ...rest} = o'),
    ['({location = 1, ...r} = o)', '({location:__pLocation = 1, ...r} = o)'],
    ['const {a: {location}, ...rest} = o', 'const {a: {__pLocation}, ...rest} = o'],
    ['class A { m({location}) {} }', 'class A { m({__pLocation}) {} }'],
    ['x = { m({location}) {} }', 'x = { m({__pLocation}) {} }'],
    ['x = { set s({location}) {} }', 'x = { set s({__pLocation}) {} }'],
    ['f({location}, function ({location}) {})', 'f({location:__pLocation}, function ({__pLocation}) {})'],
    ['const {location: {href}} = window', 'const {__pLocation: {href}} = window'],
    ['let a, {location} = o', 'let a, {__pLocation} = o'],
    ['({ location: a.b } = o)', '({ __pLocation: a.b } = o)'],
    ['[location = 1] = o', '[__pLocation = 1] = o'],
    same('const {"location": x} = o'),
    ['import("x").then(({location}) => location)', 'import("x").then(({__pLocation}) => __pLocation)'],
  ],

  'class bodies': [
    [
      "class A { location = 1; static location = 2; location; static location; location() {} static location() {} get location() {} set location(v) {} static get location() {} async location() {} *location() {} static async *location() {} accessor location = 1; ['location'] = 1; [location] = 2; 'location'() {} }",
      "class A { location = 1; static location = 2; location; static location; location() {} static location() {} get location() {} set location(v) {} static get location() {} async location() {} *location() {} static async *location() {} accessor location = 1; ['location'] = 1; [__pLocation] = 2; 'location'() {} }",
      'loose', // `accessor` is not shipped in V8 yet
    ],
    ['class A { x = location; y = location.href\n location = 1 }', 'class A { x = __pLocation; y = __pLocation.href\n location = 1 }'],
    ['class A { static { location.href } }', 'class A { static { __pLocation.href } }'],
    ['class A extends B { location = location }', 'class A extends B { location = __pLocation }'],
    ['x = class { location() { return location } }', 'x = class { location() { return __pLocation } }'],
    same("class A { 'a' = 1\n location }"),
    same('class A { m() {} location }'),
    ['class A { location = () => location }', 'class A { location = () => __pLocation }'],
    ['class A { x = async location => location }', 'class A { x = async __pLocation => __pLocation }'],
    same('class A { x = a\n location() {} }'),
    ['class A extends mix({location}) { location() {} }', 'class A extends mix({location:__pLocation}) { location() {} }'],
    ['class location {}', 'class __pLocation {}'],
    ['class A { static location = location; static #x = location }', 'class A { static location = __pLocation; static #x = __pLocation }'],
    same('class A { [a] = 1; location = 2 }'),
    ['class A { a = b ? location : c }', 'class A { a = b ? __pLocation : c }'],
    ['class A { a = { location } }', 'class A { a = { location:__pLocation } }'],
  ],

  'import and export': [
    ['import { location } from "x"', 'import { location as __pLocation } from "x"', 'module'],
    same('import { location as loc } from "x"', 'module'),
    ['import { a as location } from "x"', 'import { a as __pLocation } from "x"', 'module'],
    ['import location from "x"', 'import __pLocation from "x"', 'module'],
    ['import location, { location as l2 } from "x"', 'import __pLocation, { location as l2 } from "x"', 'module'],
    ['import def, { location } from "x"', 'import def, { location as __pLocation } from "x"', 'module'],
    ['import * as location from "x"', 'import * as __pLocation from "x"', 'module'],
    ['import { location, b, location as c } from "x"', 'import { location as __pLocation, b, location as c } from "x"', 'module'],
    ['import { "location" as location } from "x"', 'import { "location" as __pLocation } from "x"', 'module'],
    ['let location; export { location }', 'let __pLocation; export { __pLocation as location, __pLocation }', 'module'],
    ['let location; export { location as loc }', 'let __pLocation; export { __pLocation as loc }', 'module'],
    ['let a; export { a as location }', 'let a; export { a as location, a as __pLocation }', 'module'],
    ['let location; export { location as location }', 'let __pLocation; export { __pLocation as location, __pLocation as __pLocation }', 'module'],
    ['let location; export { location as default }', 'let __pLocation; export { __pLocation as default }', 'module'],
    ['export { location } from "x"', 'export { location, location as __pLocation } from "x"', 'module'],
    same('export { location as l } from "x"', 'module'),
    ['export { a as location } from "x"', 'export { a as location, a as __pLocation } from "x"', 'module'],
    ['export { "a-b" as location } from "x"', 'export { "a-b" as location, "a-b" as __pLocation } from "x"', 'module'],
    ['export { default as location } from "x"', 'export { default as location, default as __pLocation } from "x"', 'module'],
    same('export * as location from "x"', 'module'),
    ['let location; export default location', 'let __pLocation; export default __pLocation', 'module'],
    ['export const location = 1', 'export const __pLocation = 1' + ALIAS, 'module'],
    ['export let location', 'export let __pLocation' + ALIAS, 'module'],
    ['export var a = 1, location = 2', 'export var a = 1, __pLocation = 2' + ALIAS, 'module'],
    ['export const a = {b: 1}, location = f(1, 2)', 'export const a = {b: 1}, __pLocation = f(1, 2)' + ALIAS, 'module'],
    ['export function location() {}', 'export function __pLocation() {}' + ALIAS, 'module'],
    ['export async function location() {}', 'export async function __pLocation() {}' + ALIAS, 'module'],
    ['export function* location() {}', 'export function* __pLocation() {}' + ALIAS, 'module'],
    ['export async function* location() {}', 'export async function* __pLocation() {}' + ALIAS, 'module'],
    ['export class location {}', 'export class __pLocation {}' + ALIAS, 'module'],
    ['export const {location} = o', 'export const {__pLocation} = o' + ALIAS, 'module'],
    ['export const {a: location} = o', 'export const {a: __pLocation} = o' + ALIAS, 'module'],
    ['export const [location] = o', 'export const [__pLocation] = o' + ALIAS, 'module'],
    ['export const {a: {location}} = o', 'export const {a: {__pLocation}} = o' + ALIAS, 'module'],
    ['export const {location, ...r} = o', 'export const {location:__pLocation, ...r} = o' + ALIAS, 'module'],
    ['export const {location: renamed} = o', 'export const {__pLocation: renamed} = o', 'module'],
    ['export default function location() {}', 'export default function __pLocation() {}', 'module'],
    ['export default class location {}', 'export default class __pLocation {}', 'module'],
    ['export const a = 1;\nlocation, b', 'export const a = 1;\n__pLocation, b', 'module'],
    ['export const a = 1\nlet location = 2', 'export const a = 1\nlet __pLocation = 2', 'module'],
    ['const m = await import("x"); m.location', 'const m = await import("x"); m.__pLocation', 'module'],
    ['import.meta.location', 'import.meta.__pLocation', 'module'],
    ['import x from "y" with { type: "json" }; location', 'import x from "y" with { type: "json" }; __pLocation', 'module'],
  ],

  'direct eval': [
    ['eval(code)', 'eval(__pRewriteJs(code))'],
    ['eval(a, b)', 'eval(__pRewriteJs(a, b))'],
    ['eval(...args)', 'eval(__pRewriteJs(...args))'],
    ['eval("location")', 'eval(__pRewriteJs("location"))'],
    ['eval(location)', 'eval(__pRewriteJs(__pLocation))'],
    ['eval(eval(x))', 'eval(__pRewriteJs(eval(__pRewriteJs(x))))'],
    ['eval ( x )', 'eval (__pRewriteJs( x ))'],
    ['eval\n(x)', 'eval\n(__pRewriteJs(x))'],
    ['eval(x,)', 'eval(__pRewriteJs(x,))'],
    ['x = a * eval(b)', 'x = a * eval(__pRewriteJs(b))'],
    ['async function f() { await eval(x) }', 'async function f() { await eval(__pRewriteJs(x)) }'],
    ['\\u0065val(x)', '\\u0065val(__pRewriteJs(x))'],
    same('eval()'),
    same('obj.eval(x)'),
    same('obj?.eval(x)'),
    same('eval?.(x)'),
    same('(0, eval)(x)'),
    same('window.eval(x)'),
    same('x = { eval(code) { return code } }'),
    same('class A { eval(c) {} static eval(c) {} async eval(c) {} *eval(c) {} }'),
    same('x = { eval: function (c) {} }'),
    same('function eval(x) {}'),
    same('new eval(x)'),
    same('eval(__pRewriteJs(x))'),
    same('eval`x`'),
    same('evaluate(x); medieval(x); eval2(x); $eval(x)'),
  ],

  'identifiers: unicode, escapes, look-alikes': [
    ['\\u006cocation.href', '__pLocation.href'],
    ['\\u{6c}ocation', '__pLocation'],
    ['l\\u006fcation', '__pLocation'],
    ['x = {\\u006cocation}', 'x = {location:__pLocation}'],
    ['x.\\u006cocation', 'x.__pLocation'],
    ['ñlocation + locationñ + location', 'ñlocation + locationñ + __pLocation'],
    ['a = location', 'a = __pLocation'],
    ['a location', 'a __pLocation'],
    ['﻿location', '﻿__pLocation'],
    same('$location + _location + location_ + location2 + location$ + Location + LOCATION'),
    ['x = \\u0061 / location', 'x = \\u0061 / __pLocation'],
    same('__pLocation.href'),
  ],

  'ASI, arrows, functions, misc operators': [
    ['let x = 1\nlocation.href = "a"', 'let x = 1\n__pLocation.href = "a"'],
    ['a = b\n(location)', 'a = b\n(__pLocation)'],
    ['var a = 1\n[location].forEach(f)', 'var a = 1\n[__pLocation].forEach(f)'],
    ['return\nlocation', 'return\n__pLocation', 'body'],
    ['location => location', '__pLocation => __pLocation'],
    ['(location, b) => location', '(__pLocation, b) => __pLocation'],
    ['async location => location', 'async __pLocation => __pLocation'],
    ['async (location) => location', 'async (__pLocation) => __pLocation'],
    ['function location() {}', 'function __pLocation() {}'],
    ['function f(location = location) {}', 'function f(__pLocation = __pLocation) {}'],
    ['x = y ?? location; x ??= location; x ||= location; x &&= location', 'x = y ?? __pLocation; x ??= __pLocation; x ||= __pLocation; x &&= __pLocation'],
    ['x = a ** location >>> location', 'x = a ** __pLocation >>> __pLocation'],
    ['x = !location, ~location', 'x = !__pLocation, ~__pLocation'],
    ['debugger; location', 'debugger; __pLocation'],
    ['x = 0x1F / location + 1_000n / location + .5e-3 / location', 'x = 0x1F / __pLocation + 1_000n / __pLocation + .5e-3 / __pLocation'],
  ],

  // ES2019 optional catch binding, as emitted by terser/esbuild/swc for modern targets: the
  // `{` after `catch` is a block, never an object literal.
  'optional catch binding': [
    ['try{a()}catch{b,location}', 'try{a()}catch{b,__pLocation}'],
    ['try{}catch{x=1,location=2}', 'try{}catch{x=1,__pLocation=2}'],
    ['try{}catch{location}', 'try{}catch{__pLocation}'],
    ["try{a()}catch{}/'/.test(s);location.href=1", "try{a()}catch{}/'/.test(s);__pLocation.href=1"],
    ['try{a()}catch{}/`/.test(s);location.href=1', 'try{a()}catch{}/`/.test(s);__pLocation.href=1'],
    ['try{a()}catch{}/[{(]/.test(s);x={location}', 'try{a()}catch{}/[{(]/.test(s);x={location:__pLocation}'],
    ['try{}catch{location:for(;;){break location}}', 'try{}catch{__pLocation:for(;;){break __pLocation}}'],
    ['try{}catch{function f(){}/location/.test(s)}', 'try{}catch{function f(){}/location/.test(s)}'],
    ['try {\n  a()\n} catch {\n  location.reload(), location\n}', 'try {\n  a()\n} catch {\n  __pLocation.reload(), __pLocation\n}'],
    ['p.catch({location})', 'p.catch({location:__pLocation})'],
  ],

  'class bodies: operators that look like member prefixes': [
    ['class A { x = a\n* location }', 'class A { x = a\n* __pLocation }'],
    ['class A { x = a\n*location(1) }', 'class A { x = a\n*__pLocation(1) }'],
    same('class A { x = a;\n*location() {} }'),
    same('class A { *location() {} static *location() {} }'),
  ],
};

for (const [group, cases] of Object.entries(CASES)) {
  test('rewriteJs: ' + group, () => {
    const problems = [];
    for (const [input, expected, mode] of cases) {
      const got = rewriteJs(input);
      if (got !== expected) {
        problems.push(`rewriteJs(${JSON.stringify(input)})\n    got:      ${JSON.stringify(got)}\n    expected: ${JSON.stringify(expected)}`);
        continue;
      }
      if (mode === 'module' || mode === 'loose') continue;
      const inErr = scriptError(input, mode);
      const outErr = scriptError(got, mode);
      if (!inErr && outErr) problems.push(`output does not parse (${outErr}): ${JSON.stringify(got)}`);
      if (inErr) problems.push(`test input does not parse (${inErr}): ${JSON.stringify(input)}`);
    }
    assert.ok(problems.length === 0, '\n' + problems.join('\n'));
  });
}

test('rewriteJs: module cases parse before and after rewriting', () => {
  const mods = CASES['import and export'].concat(CASES['class bodies'].filter((c) => c[2] !== 'loose'));
  const sources = [];
  for (const [input] of mods) sources.push(input, rewriteJs(input));
  const errors = moduleErrors(sources);
  const problems = [];
  errors.forEach((err, k) => { if (err) problems.push(`${err}: ${JSON.stringify(sources[k])}`); });
  assert.ok(problems.length === 0, '\n' + problems.join('\n'));
});

// --- robustness ----------------------------------------------------------------------------

test('rewriteJs: tolerates invalid, unterminated and pathological input', () => {
  for (const v of [undefined, null, '', 42]) assert.equal(rewriteJs(v), v);
  const broken = [
    '"unterminated location', "'a\nlocation'", '`unterminated ${location', '`a ${ {location', '/* unterminated location',
    'x = /unterminated location', ')))]]]}}} location ((({{{', '} location {', 'location: {', '#', '\\', '\\u', '\\u{', 'x = `${',
    '<!--', '-->', 'a ? location', '.location', '?.location', '...location', 'eval(', 'eval(location', 'export {location',
    'import {location', 'class { location', 'class A extends { location', 'function (location', '@', ' ', 'location\\',
  ];
  for (const s of broken) {
    assert.equal(typeof rewriteJs(s), 'string', JSON.stringify(s));
    assert.equal(typeof rewriteScript(s), 'string', JSON.stringify(s));
  }
  assert.equal(rewriteJs('x = "location"'), 'x = "location"');
});

test('rewriteJs: deep nesting and huge numbers of hits stay linear', () => {
  const depth = 100000;
  let src = 'x = ' + '['.repeat(depth) + 'location' + ']'.repeat(depth);
  let t = Date.now();
  assert.ok(rewriteJs(src).includes('[__pLocation]'));
  src = 'export const ' + '['.repeat(depth) + 'location' + ']'.repeat(depth) + ' = x;';
  assert.ok(rewriteJs(src).endsWith(ALIAS));
  src = 'export {};' + 'location,'.repeat(200000) + '0';
  assert.equal(rewriteJs(src).split('__pLocation').length - 1, 200000);
  src = 'x = (' + '{location: {'.repeat(20000) + '}}'.repeat(20000) + ')';
  rewriteJs(src);
  src = '`${'.repeat(30000) + 'location' + '}`'.repeat(30000);
  assert.ok(rewriteJs(src).includes('${__pLocation}'));
  const ms = Date.now() - t;
  assert.ok(ms < 5000, 'pathological inputs took ' + ms + 'ms');
});

// --- guard ---------------------------------------------------------------------------------

test('rewriteScript: guard placement respects hashbang and directive prologue', () => {
  assert.equal(rewriteScript('x = 1'), 'x = 1');
  assert.equal(rewriteScript('location'), GUARD + '__pLocation');
  assert.equal(rewriteScript('location', { guard: false }), '__pLocation');
  assert.equal(rewriteScript('eval(x)'), GUARD + 'eval(__pRewriteJs(x))');
  assert.equal(rewriteScript('"use strict";location'), '"use strict";' + GUARD + '__pLocation');
  assert.equal(rewriteScript("'use strict'\nlocation"), "'use strict';" + GUARD + '\n__pLocation');
  assert.equal(rewriteScript('// c\n/* d */ \'use client\'; "use strict"; location'), '// c\n/* d */ \'use client\'; "use strict";' + GUARD + ' __pLocation');
  assert.equal(rewriteScript('"use strict".length; location'), GUARD + '"use strict".length; __pLocation');
  assert.equal(rewriteScript('"use strict"\n+ location'), GUARD + '"use strict"\n+ __pLocation');
  assert.equal(rewriteScript('#!/bin/node\n"use strict";location'), '#!/bin/node\n"use strict";' + GUARD + '__pLocation');
  assert.equal(rewriteScript('function f() { "use strict"; location }'), GUARD + 'function f() { "use strict"; __pLocation }');
  // idempotent, and the guard itself survives another rewrite untouched
  const once = rewriteScript('"use strict"; eval(location)');
  assert.equal(rewriteScript(once), once);
  assert.equal(rewriteJs(GUARD), GUARD);
  for (const s of [once, rewriteScript("'use strict'\nlocation")]) assert.equal(scriptError(s), null, s);
  // strictness survives: the directive still comes first
  const ctx = vm.createContext({});
  assert.equal(vm.runInContext(rewriteScript('"use strict"; var location = 1; (function () { return this === undefined })()'), ctx), true);
});

test('GUARD: defines the fallbacks in a bare realm without clobbering existing ones', () => {
  const ctx = vm.createContext({});
  vm.runInContext('var location = { pathname: "/real" }; var holder = { location: 7 };' + GUARD, ctx);
  assert.equal(vm.runInContext('__pLocation.pathname', ctx), '/real');
  assert.equal(vm.runInContext('holder.__pLocation', ctx), 7);
  vm.runInContext('holder.__pLocation = 8', ctx);
  assert.equal(vm.runInContext('holder.location', ctx), 8);
  assert.equal(vm.runInContext('__pRewriteJs("location")', ctx), 'location');
  assert.equal(vm.runInContext('__pRewriteJs(5)', ctx), 5);
  assert.equal(vm.runInContext('Object.keys(globalThis).includes("__pRewriteJs")', ctx), false);
  assert.equal(vm.runInContext('for (var k in {}) k; Object.keys({}).length', ctx), 0);
  // `with` scopes only capture __pLocation when the object really has a `location`
  assert.equal(vm.runInContext('with ({ other: 1 }) { __pLocation.pathname }', ctx), '/real');
  assert.equal(vm.runInContext('with ({ location: { pathname: "/own" } }) { __pLocation.pathname }', ctx), '/own');

  const ctx2 = vm.createContext({});
  vm.runInContext('var hook = function (s) { return "hooked:" + s }; var __pRewriteJs = hook;' +
    'Object.defineProperty(Object.prototype, "__pLocation", { configurable: true, get: function () { return "runtime" } });' + GUARD, ctx2);
  assert.equal(vm.runInContext('__pRewriteJs === hook && ({}).__pLocation', ctx2), 'runtime');

  // DOM prototypes carry their own @@unscopables objects (inline event handler scopes)
  const dom = vm.createContext({});
  vm.runInContext('function Element() {} Element.prototype[Symbol.unscopables] = { append: true }; function Document() {}' + GUARD, dom);
  assert.equal(vm.runInContext('Element.prototype[Symbol.unscopables].__pLocation === true && !(Symbol.unscopables in Document.prototype && Object.getOwnPropertyDescriptor(Document.prototype, Symbol.unscopables))', dom), true);

  const frozen = vm.createContext({});
  vm.runInContext('Object.freeze(Object.prototype);' + GUARD + 'var ok = true;', frozen);
  assert.equal(vm.runInContext('ok', frozen), true);
  assert.equal(scriptError('"use strict";' + GUARD), null);
});

// --- isomorphic build ------------------------------------------------------------------------

test('rewrite-js.js runs in a browser-like realm and only publishes __proxyRewriteJs', () => {
  const code = fs.readFileSync(SRC, 'utf8');
  const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(withoutComments, /\brequire\s*\(|\bprocess\.|\bBuffer\b|__dirname|__filename|\bsetImmediate\b/);
  const ctx = vm.createContext({});
  const before = new Set(vm.runInContext('Object.getOwnPropertyNames(globalThis)', ctx));
  vm.runInContext(code, ctx);
  const added = read(ctx, 'Object.getOwnPropertyNames(globalThis)').filter((k) => !before.has(k));
  assert.deepEqual(added, ['__proxyRewriteJs']);
  assert.equal(vm.runInContext('typeof __proxyRewriteJs.rewriteJs + typeof __proxyRewriteJs.rewriteScript', ctx), 'functionfunction');
  assert.equal(vm.runInContext('__proxyRewriteJs.rewriteJs("x = {location}; eval(s)")', ctx), 'x = {location:__pLocation}; eval(__pRewriteJs(s))');
  assert.equal(vm.runInContext('Object.keys(globalThis).includes("__proxyRewriteJs")', ctx), false);
  // concatenated in front of a sloppy script: no shared lexical names, no inherited strict mode
  const page = vm.createContext({});
  vm.runInContext(code + '\n;const NAME = 1, WORDS = 2, GUARD = 3, tokenize = 4; with ({}) {} var sloppy = (function () { return this })() === globalThis;', page);
  assert.equal(vm.runInContext('sloppy', page), true);
  // also usable from a worker-like global that only has `self`
  const worker = vm.createContext({});
  vm.runInContext('var self = globalThis;', worker);
  vm.runInContext(code, worker);
  assert.equal(vm.runInContext('self.__proxyRewriteJs.rewriteJs("location")', worker), '__pLocation');
});

test('exports keep their names and values', () => {
  assert.equal(REPLACEMENT, '__pLocation');
  assert.equal(EVAL_HOOK, '__pRewriteJs');
  assert.ok(GUARD.includes('Object.prototype') && GUARD.includes('__pRewriteJs'));
});

// --- semantics -----------------------------------------------------------------------------

const REAL = '{ href: "https://site.example/a/b?q=1#h", pathname: "/a/b", search: "?q=1", hash: "#h", host: "site.example", port: "" }';

function runScript(code, extra) {
  const ctx = vm.createContext({});
  vm.runInContext('var window = this; var location = ' + REAL + ';' + (extra || ''), ctx);
  ctx.__pRewriteJs = (s) => (typeof s === 'string' ? rewriteJs(s) : s);
  vm.runInContext(code, ctx);
  return ctx;
}

test('edge-cases.js fixture behaves identically after rewriting', () => {
  const src = fs.readFileSync(path.join(FIXTURES, 'edge-cases.js'), 'utf8');
  const out = rewriteScript(src);
  assert.notEqual(out, src);
  const before = read(runScript(src), 'out');
  const after = read(runScript(out), 'out');
  assert.ok(before.length > 50);
  assert.deepEqual(after, before);
  assert.ok(after.includes('direct eval local local!'));
  assert.ok(after.includes('L {"z":1}'));
});

test('rewritten code sees the virtual location the runtime provides', () => {
  // A stand-in for the browser runtime: the window gets a different (virtual) location.
  const runtime = 'var virtual = { href: "https://real.example/page?x=1", pathname: "/page", search: "?x=1", hash: "", host: "real.example", port: "" };' +
    'Object.defineProperty(Object.prototype, "__pLocation", { configurable: true,' +
    ' get: function () { return this === window ? virtual : this["location"] },' +
    ' set: function (v) { if (this === window) virtual.href = String(v); else this["location"] = v } });';
  const code = rewriteScript([
    'var r = [location.pathname, window.location.search, this.location.host];',
    'var { location: l } = window; r.push(l.pathname);',
    '(function ({ location }) { r.push(location.pathname) })(window);',
    'var own = { location: "own" }; r.push(own.location, { location }.location.pathname);',
    'with ({}) { r.push(location.href) }',
    'r.push((function () { var location = "local"; return eval("location") })());',
    'location.href = "https://real.example/next"; r.push(location.href);',
  ].join('\n'));
  const ctx = runScript(code, runtime);
  assert.deepEqual(read(ctx, 'r'), ['/page', '?x=1', 'real.example', '/page', '/page', 'own', '/page', 'https://real.example/page?x=1', 'local', 'https://real.example/next']);
});

test('history UMD fixture: createBrowserHistory reports the virtual location', () => {
  const src = fs.readFileSync(path.join(FIXTURES, 'history.production.min.js'), 'utf8');
  const browser = 'var listeners = {}; window.addEventListener = function (t, f) { listeners[t] = f }; window.removeEventListener = function () {};' +
    'var proxied = { pathname: "/p/https://real.example/app/item", search: "?id=7", hash: "#top", href: "http://proxy.local/p/https://real.example/app/item?id=7#top" };' +
    'var virtual = { pathname: "/app/item", search: "?id=7", hash: "#top", href: "https://real.example/app/item?id=7#top" };' +
    'location = proxied; window.document = { defaultView: window };' +
    'window.history = { state: null, length: 1, pushState: function (s, t, u) { this.state = s; this.url = u }, replaceState: function (s, t, u) { this.state = s; this.url = u } };' +
    'Object.defineProperty(Object.prototype, "__pLocation", { configurable: true, get: function () { return this === window ? virtual : this["location"] } });';
  const probe = ';var h = HistoryLibrary.createBrowserHistory({ window: window }); var seen = [h.location.pathname, h.location.search, h.location.hash, h.createHref({ pathname: "/x" })];';
  const original = runScript(src + probe, browser);
  const rewritten = runScript(rewriteScript(src) + probe, browser);
  assert.deepEqual(read(original, 'seen'), ['/p/https://real.example/app/item', '?id=7', '#top', '/x']);
  assert.deepEqual(read(rewritten, 'seen'), ['/app/item', '?id=7', '#top', '/x']);
});

test('direct eval keeps its scope and gets rewritten source', () => {
  const code = rewriteScript('var r = (function () { "use strict"; var location = { pathname: "/local" }; return [eval("location.pathname"), eval("typeof location"), eval(), eval(42)] })();');
  assert.deepEqual(read(runScript(code), 'r'), ['/local', 'object', null, 42]);
  // with only the guard's identity hook the evaluated source is not rewritten: same scope, raw name
  const ctx = vm.createContext({});
  vm.runInContext('var location = { pathname: "/global" };', ctx);
  vm.runInContext(code, ctx);
  assert.deepEqual(read(ctx, 'r'), ['/global', 'object', null, 42]);
});

test('edge-cases.mjs fixture and an exporting dependency behave identically after rewriting', () => {
  const entry = fs.readFileSync(path.join(FIXTURES, 'edge-cases.mjs'), 'utf8');
  const dep = [
    "export const location = 'dep-location';",
    'export function readLocation() { return location; }',
    "export function other() { return 'other'; }",
    "export default 'dep-default';",
  ].join('\n');
  // namespace objects have no prototype: `ns.location` only survives through the export twins
  const listed = "const location = 'listed'; const other = 'other'; export { location, other as location2 };";
  const renamed = "const x = 'renamed'; export { x as location };";
  const barrel = "export { location } from 'listed'; export { location as location3 } from 'renamed';";
  const reader = [
    "import * as listed from 'listed'; import * as renamed from 'renamed'; import * as barrel from 'barrel';",
    "const ns = await import('listed');",
    'export const seen = [listed.location, listed.location2, renamed.location, barrel.location, barrel.location3, ns.location];',
  ].join('\n');
  const graph = { entry, dep, listed, renamed, barrel, reader };
  const rewritten = Object.fromEntries(Object.entries(graph).map(([k, v]) => [k, rewriteScript(v)]));
  const prelude = 'globalThis.location = ' + REAL + ';';
  const [before, after, readBefore, readAfter] = runChild([
    { kind: 'run', prelude, entry: 'entry', modules: graph },
    { kind: 'run', prelude, entry: 'entry', modules: rewritten },
    { kind: 'run', prelude, entry: 'reader', modules: graph },
    { kind: 'run', prelude, entry: 'reader', modules: rewritten },
  ]);
  assert.ok(readBefore.ok, readBefore.error);
  assert.ok(readAfter.ok, readAfter.error);
  assert.equal(readBefore.view.seen, '["listed","other","renamed","listed","renamed","listed"]');
  assert.deepEqual(readAfter.view, readBefore.view);
  assert.ok(before.ok, before.error);
  assert.ok(after.ok, after.error);
  assert.deepEqual(after.view, before.view);
  assert.match(before.view.results, /dep-location true dep-default dep-location dep-location/);
  assert.equal(before.view.location, '"dep-location"');
  assert.equal(before.view.fromDep, '"dep-location"');
  assert.ok(rewriteScript(dep).endsWith(ALIAS));
});

// --- real-world fixtures -------------------------------------------------------------------

/*
 * Independent check that the output differs from the input only by the intended edits: both are
 * split into identifier-like words and single punctuation characters (no JS tokenizer
 * involved) and walked in lockstep, allowing just the rewrite's transformations.
 */
const UNITS = /[\p{ID_Continue}$\\‌‍]+|\S/gu;
function lexicalDiff(input, output) {
  const A = input.match(UNITS) || [], B = output.match(UNITS) || [];
  const stats = { renamed: 0, expanded: 0, importAs: 0, exportAs: 0, exportTwin: 0, evalWrapped: 0, kept: 0 };
  let i = 0, j = 0, pending = 0;
  while (i < A.length || j < B.length) {
    const a = A[i], b = B[j];
    if (a === 'location') {
      if (b === 'location' && B[j + 1] === ':' && B[j + 2] === REPLACEMENT && A[i + 1] !== ':') { stats.expanded++; i++; j += 3; continue; }
      if (b === 'location' && B[j + 1] === 'as' && B[j + 2] === REPLACEMENT && A[i + 1] !== 'as') { stats.importAs++; i++; j += 3; continue; }
      if (b === REPLACEMENT && B[j + 1] === 'as' && B[j + 2] === 'location' && B[j + 3] === ',' && B[j + 4] === REPLACEMENT && A[i + 1] !== 'as') { stats.exportAs++; i++; j += 5; continue; }
      if (b === REPLACEMENT && B[j + 1] === 'as' && B[j + 2] === 'location' && A[i + 1] !== 'as') { stats.exportAs++; i++; j += 3; continue; }
      if (b === REPLACEMENT) { stats.renamed++; i++; j++; continue; }
      if (b === 'location') { stats.kept++; i++; j++; continue; }
    }
    // `export { x as location }` gains a `, x as __pLocation` twin (checked before `,` can match)
    if (b === ',' && B[j + 2] === 'as' && B[j + 3] === REPLACEMENT && A[i - 1] === 'location') { stats.exportTwin++; j += 4; continue; }
    if (a === b) { i++; j++; continue; }
    if (b === EVAL_HOOK && B[j + 1] === '(' && A[i - 1] === '(' && A[i - 2] === 'eval') { stats.evalWrapped++; pending++; j += 2; continue; }
    if (b === ')' && pending > 0) { pending--; j++; continue; }
    throw new Error(`unexpected difference at unit ${i}: ${JSON.stringify(A.slice(Math.max(0, i - 6), i + 6))} vs ${JSON.stringify(B.slice(Math.max(0, j - 6), j + 6))}`);
  }
  assert.equal(pending, 0);
  return stats;
}

function stripAdditions(out) {
  let s = out.replace(GUARD, '');
  if (s.endsWith(ALIAS)) s = s.slice(0, -ALIAS.length);
  return s;
}

// Counts were cross-checked against an acorn AST of each output (every remaining `location` is
// a key, member name or module-facing name; every `__pLocation` a reference or binding).
const FIXTURE_EXPECTATIONS = {
  'history.production.min.js': { renamed: 5, expanded: 0, importAs: 0, exportAs: 0, exportTwin: 0, evalWrapped: 0, kept: 11 },
  'history.mjs': { renamed: 32, expanded: 0, importAs: 0, exportAs: 0, exportTwin: 0, evalWrapped: 0, kept: 23 },
  'page.js': { renamed: 13, expanded: 0, importAs: 0, exportAs: 0, exportTwin: 0, evalWrapped: 0, kept: 1 },
  'react-router.production.min.js': { renamed: 12, expanded: 0, importAs: 0, exportAs: 0, exportTwin: 0, evalWrapped: 0, kept: 9 },
  'jquery.min.js': { renamed: 4, expanded: 0, importAs: 0, exportAs: 0, exportTwin: 0, evalWrapped: 0, kept: 0 },
  'edge-cases.js': { renamed: 98, expanded: 8, importAs: 0, exportAs: 0, exportTwin: 0, evalWrapped: 3, kept: 52 },
  'edge-cases.mjs': { renamed: 20, expanded: 2, importAs: 1, exportAs: 1, exportTwin: 0, evalWrapped: 2, kept: 13 },
};

test('fixtures: output parses and differs only by the intended edits', () => {
  const problems = [];
  const modules = [];
  const stats = {};
  for (const name of Object.keys(FIXTURE_EXPECTATIONS)) {
    const src = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
    const out = rewriteScript(src);
    if (name.endsWith('.mjs')) modules.push([name, out]);
    else {
      const err = scriptError(out);
      if (err) problems.push(`${name}: output does not parse: ${err}`);
    }
    try {
      stats[name] = lexicalDiff(src, stripAdditions(out));
    } catch (e) {
      problems.push(`${name}: ${e.message}`);
    }
  }
  moduleErrors(modules.map((m) => m[1])).forEach((err, k) => { if (err) problems.push(`${modules[k][0]}: output does not parse: ${err}`); });
  assert.ok(problems.length === 0, '\n' + problems.join('\n'));
  assert.deepEqual(stats, FIXTURE_EXPECTATIONS);
});

// --- performance ---------------------------------------------------------------------------

test('performance: a 3 MB minified bundle rewrites in under 300 ms', (t) => {
  const parts = ['history.production.min.js', 'react-router.production.min.js', 'jquery.min.js']
    .map((f) => ';(function(){\n' + fs.readFileSync(path.join(FIXTURES, f), 'utf8') + '\n}).call(this);\n');
  let bundle = '';
  while (bundle.length < 3 * 1024 * 1024) bundle += parts.join('');
  const times = [];
  let out;
  for (let k = 0; k < 3; k++) {
    const t0 = process.hrtime.bigint();
    out = rewriteScript(bundle);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  t.diagnostic(`${(bundle.length / 1048576).toFixed(2)} MB: ${times.map((x) => x.toFixed(0)).join(' / ')} ms`);
  assert.ok(Math.min(...times) < 300, 'rewrite took ' + times.join(', ') + ' ms');
  assert.equal(scriptError(out), null);
});

// --- adversarial input: the server rewrites on its event loop, so no input may go superlinear --

test('hostile input: no quadratic rescans or deep recursion', () => {
  const cases = {
    // every `/` after `[` starts a regex scan that fails at the end of one long line
    'unterminated regex classes': 'x=location;' + '/['.repeat(150000),
    'unterminated regexes in brackets': 'x=location;' + '(/['.repeat(100000),
    // many keys of one destructuring pattern, each re-checking a huge last element for `...rest`
    'pattern keys before a huge default': '({' + 'location:a,'.repeat(20000) + 'z=' + '1+'.repeat(150000) + '1}=o)',
    'pattern keys before a huge template': '({' + 'location:a,'.repeat(20000) + 'z=`' + '${a}'.repeat(100000) + '`}=o)',
    // generator-star chains used to recurse once per `*`
    'star chain in a class body': 'class A{' + '* '.repeat(300000) + 'location}',
  };
  for (const [name, src] of Object.entries(cases)) {
    const t0 = Date.now();
    const out = rewriteJs(src);
    const ms = Date.now() - t0;
    assert.equal(typeof out, 'string', name);
    assert.ok(out.includes('__pLocation'), name);
    assert.ok(ms < 1500, `${name}: ${(src.length / 1024).toFixed(0)} KB took ${ms} ms`);
  }
});

// Script text can be rewritten twice: the server rewrites JS fetched with fetch()/XHR (by its
// content type), and the client runtime rewrites it again when the page evals it or inserts it
// as a <script>. The second pass must be a no-op, or modules end up with duplicate exports.
test('rewriteJs is idempotent, including module export twins', () => {
  const sources = [
    ['let location; export { location }', 'module'],
    ['export const location = 1', 'module'],
    ['export const {location} = o', 'module'],
    ['export { location } from "x"', 'module'],
    ['let a; export { a as location }', 'module'],
    ['let location; export { location as location }', 'module'],
    ['export { default as location } from "x"', 'module'],
    ['import { location } from "x"; export { location }', 'module'],
    ['x = {location}; const {location: l, ...r} = o; eval(location); class A { location = location }', 'script'],
  ];
  const problems = [];
  const mods = [];
  for (const [src, mode] of sources) {
    const once = rewriteJs(src);
    const twice = rewriteJs(once);
    if (twice !== once) problems.push(`${JSON.stringify(src)}\n    once:  ${JSON.stringify(once)}\n    twice: ${JSON.stringify(twice)}`);
    if (mode === 'module') mods.push(twice);
    else if (scriptError(twice)) problems.push(`does not parse: ${JSON.stringify(twice)}`);
    const guarded = rewriteScript(src);
    if (rewriteScript(guarded) !== guarded) problems.push(`rewriteScript not idempotent: ${JSON.stringify(src)}`);
  }
  moduleErrors(mods).forEach((err, k) => { if (err) problems.push(`${err}: ${JSON.stringify(mods[k])}`); });
  assert.ok(problems.length === 0, '\n' + problems.join('\n'));
});

// The @@unscopables object the GUARD hands to `with` scopes must not inherit from
// Object.prototype: an inherited `toString`/`constructor`/`valueOf` is truthy and would hide the
// with-object's own members of those names (lodash/underscore/EJS templates use `with (obj)`).
test('GUARD: with-scopes still see their own Object.prototype-named members', () => {
  const code = 'var obj = { toString: function () { return "mine" }, constructor: "ctor", valueOf: function () { return 42 },' +
    ' hasOwnProperty: function () { return "own" }, isPrototypeOf: 1, propertyIsEnumerable: 2, toLocaleString: 3, location: { pathname: "/own" } };' +
    'var r; with (obj) { r = [toString(), constructor, valueOf(), hasOwnProperty("x"), isPrototypeOf, propertyIsEnumerable, toLocaleString, __pLocation.pathname] } r';
  const plain = vm.createContext({});
  const expected = read(plain, '(function () { ' + code.replace('__pLocation', 'location') + '; return r })()');
  const guarded = vm.createContext({});
  vm.runInContext(GUARD, guarded);
  assert.deepEqual(read(guarded, '(function () { ' + code + '; return r })()'), expected);
  // a template engine in the style of _.template: data fields named like Object.prototype members
  const tpl = 'var data = { constructor: "C", name: "n" }; var out; with (data) { out = name + "/" + constructor } out';
  assert.equal(vm.runInContext(GUARD + tpl, vm.createContext({})), 'n/C');
  // arrays carry their own (null-prototype) @@unscopables: `with (array)` must not capture it
  const arr = vm.createContext({});
  vm.runInContext('var location = { pathname: "/real" };' + GUARD, arr);
  assert.equal(vm.runInContext('with ([1, 2]) { __pLocation.pathname + length }', arr), '/real2');
  assert.equal(vm.runInContext('Object.keys(Array.prototype[Symbol.unscopables]).includes("__pLocation")', arr), false);
});
