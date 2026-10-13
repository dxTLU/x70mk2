/*
 * Hand-written regression fixture for src/rewrite-js.js: the ways real scripts spell `location`.
 * test/rewrite-js.test.js runs it before and after rewriting (guard installed, eval hook live)
 * and expects identical output, so every construct here must keep its meaning.
 */
var out = [];
function log() { out.push(Array.prototype.map.call(arguments, String).join(' ')); }

// member access, optional chaining, computed access
log(location.href, window.location.pathname, this.location === location);
log(globalThis?.location?.hash, window?.['location'].search);
var holder = { location: { href: 'holder' } };
log(holder.location.href, holder?.location?.href, holder['location'].href);
holder.location = { href: 'reassigned' };
log(holder.location.href, holder.location?.href.length);
log(location
  .host);

// regular expressions vs division
var a = 10, b = 2, g = 5, i = 0;
log(a / b / g, (a) / b / g, [a][0] / b / g, a++ / 2, a-- / 2);
var re = /location\/[/]location/g;
log(re.source, /[/location]/.test('/'), typeof /location/);
if (a) /location/.test('location') && log('regex after if');
log(`${a}` / 2, a
/b/g);
function declared() {}
/location/.test('x') || log('regex after a function declaration');
log(function () { return 4; } / 2, {} / 2, a /= 2);
log(holder.location.href.length / location.href.length > 0);
var x = a ? /location/.source : b;
log(x, a in { a: 1 } ? /x/.source : 0, a.toString / 2);

// template literals
log(`location ${location.pathname} ${`nested ${location.hash} ${'}'}`} {location} ${ { location }.location.pathname }`);
log(`\${location}`, `$location`, `${'$'}{location}`);
function tag(s) { return s.raw.join('|') + (arguments.length - 1); }
log(tag`a${location.port}b${`${location.host}`}c`);

// comments
log(location /* location */ . /* location */ pathname); // location
<!-- HTML-like comment: location.href = 'nowhere'
--> HTML close comment at line start: location.href = 'nowhere'
log('after html comments');

// object literals
var shorthand = { location };
log(shorthand.location.pathname, Object.keys(shorthand));
var keys = { location: 1, 'location': 2, ['loc' + 'ation']: 3, a, location, b };
log(typeof keys.location, Object.keys(keys).join());
var methods = {
  location() { return 'method'; },
  get value() { return location.pathname; },
};
log(methods.location(), methods.value);
var accessors = { get location() { return 'got'; }, set location(v) { this.v = v; } };
accessors.location = 'set';
log(accessors.location, accessors.v);
var gen = { *location() { yield 'gen'; }, async location2() {} };
log(gen.location().next().value);
var nested = { a: { location }, b: [location][0].pathname, c: a ? { location } : { location: 0 }, d: { e: { location: { location } } } };
log(nested.a.location.pathname, nested.b, nested.c.location.pathname, nested.d.e.location.location.pathname);
log((() => ({ location }))().location.pathname, { ...location }.pathname, [...[location]][0].pathname);

// blocks, labels, statements
{ location.hash; }
location: for (i = 0; i < 3; i++) { for (;;) { if (i === 1) continue location; break location; } }
log(i);
switch (location.pathname) { case location.pathname: log('case'); break; default: log('default'); }
do { log('do', location.pathname); } while (false)
try { throw location; } catch (location) { log('caught', location.pathname); } finally { log('finally'); }
with ({ other: 1 }) { log('with', location.pathname); }
with ({ location: { pathname: '/own' } }) { log('with own', location.pathname); }
log(location ? 'truthy' : 'falsy', typeof location, 'location' in window);

// destructuring
var { location: renamed } = window;
var { location: { pathname: deepPath } } = window;
log(renamed.pathname, deepPath);
(function () { var { location } = window; log('destructured', location.pathname); })();
(function ({ location }, [, { location: second }] = [0, { location: 'second' }]) { log(location, second); })({ location: 'first' });
var pick = ({ location = 'default' }) => location;
log(pick({}), pick({ location: 'given' }));
var { location: withDefault = 'd' } = {};
var [{ location: fromArray }] = [window];
log(withDefault, fromArray.pathname);
var restTarget = {};
({ location: restTarget.loc, ...restTarget.rest } = { location: 'L', z: 1 });
log(restTarget.loc, JSON.stringify(restTarget.rest));
for (var { location: forLoc } of [window]) log('for-of', forLoc.pathname);
for (var k in { location: 1 }) log('for-in', k);
try { throw { location: 'thrown' }; } catch ({ location }) { log('catch pattern', location); }
var { a: { location: deep2 } = { location: 'deep default' } } = {};
var { [`loc${'ation'}`]: computed } = window;
log(deep2, computed.pathname);

// classes
class Base {
  location = 'field';
  static location = 'static field';
  #location = 'private';
  ['loc' + 'ation2'] = 'computed field';
  get loc() { return this.location + '|' + this.#location + '|' + (#location in this); }
  where() { return location.pathname; }
  static { Base.fromStatic = location.pathname; }
}
var base = new Base();
log(base.loc, Base.location, base.location2, base.where(), Base.fromStatic);
class Parent { get location() { return 'parent'; } }
class Child extends Parent { get location() { return 'child>' + super.location; } }
log(new Child().location);
var Anon = class { location() { return 'class expression method'; } };
log(new Anon().location(), (class {} / 2));
class Fields {
  a = location.pathname
  location
  b = 1
  static async *location2() {}
}
log(new Fields().a, 'location' in new Fields(), new Fields().location, new Fields().b);

// functions and scoping
function withParam(location) { return location * 2; }
var arrow = location => location + 1;
var asyncArrow = async location => location;
log(withParam(21), arrow(1), typeof asyncArrow);
(function () { function location() { return 'inner function'; } log(location()); })();
(function () { var location = 'shadowed'; log(location); })();
(function () { let location = 'outer'; { let location = 'inner'; log(location); } log(location); })();

// eval
(function () { var location = 'local'; log('direct eval', eval('location'), eval('location + "!"')); })();
log('indirect eval', (0, eval)('typeof location'), eval('1 + 1'));
var evaluator = { eval(code) { return 'method:' + code; } };
log(evaluator.eval('x'), evaluator?.eval('y'));

// unicode
log(location.pathname, location.hash);
var ünïcödé = 'unicode ok', \u{63}afé = 'escaped';
log(ünïcödé, café);
var $location = 1, _location = 2, location_ = 3, location2 = 4;
log($location + _location + location_ + location2);

// automatic semicolon insertion
var asi = 1
location.pathname
log(asi)
var asi2 = location
  .pathname
log(asi2)
var asi3 = function () {}
;(function () { log('asi iife'); })()
function ret() {
  return {
    location
  }
}
function retAsi() {
  return
  { location }
}
log(ret().location.pathname, retAsi());

// assignment
var saved = location;
location = { pathname: '/assigned', href: 'x', hash: '', search: '', host: '', port: '' };
log(location.pathname, window.location.pathname);
location = saved;
log(location.pathname);
