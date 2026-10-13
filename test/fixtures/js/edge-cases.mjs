/*
 * Hand-written module fixture for src/rewrite-js.js (see edge-cases.js). 'dep' resolves to a
 * module defined in test/rewrite-js.test.js; the test evaluates both modules before and after
 * rewriting and expects the same exports, so module-facing names must survive the rename.
 */
import dflt, { location, location as viaAlias, readLocation } from 'dep';
import * as dep from 'dep';

export { location };
export { location as importedAgain };
export { location as fromDep, other as depOther } from 'dep';
export * as depNamespace from 'dep';

export const results = [];
const log = (...v) => results.push(v.map(String).join(' '));

log(location, viaAlias === location, dflt, dep.location, readLocation());
log(globalThis.location.pathname, typeof globalThis.location);

export let { location: destructured } = { location: 'destructured' };
export const [first, { location: second }] = [location, { location: 'second' }];
export function withDefault({ location } = { location: 'param default' }) { return location; }
export class Exported {
  location = 'field';
  static location = 'static';
  get loc() { return this.location + '/' + Exported.location; }
}
export default class { location() { return 'default class method'; } }
log(destructured, first, second, withDefault(), withDefault({ location: 'given' }), new Exported().loc);

const obj = { location, nested: { location }, ['loc' + 'ation2']: location };
const { location: picked, ...others } = { location: 'picked', z: 1 };
log(JSON.stringify(obj), picked, JSON.stringify(others));
log(eval('location'), eval('typeof readLocation'), (0, eval)('typeof location'));
log(typeof import.meta, typeof import.meta.location);

label: for (const location of ['a', 'b']) { if (location === 'b') break label; log('loop', location); }
log(`${location}:${`${globalThis.location.hash}`}`);
