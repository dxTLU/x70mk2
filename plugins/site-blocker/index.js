'use strict';

function domains(text) {
  return String(text || '').split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:?#].*$/, '').replace(/^\*?\./, ''))
    .filter(Boolean);
}

module.exports = () => ({
  onRequest(ctx) {
    const host = new URL(ctx.url).hostname.toLowerCase();
    const hit = domains(ctx.settings.blocked).find((d) => host === d || host.endsWith('.' + d));
    if (hit) return { block: { status: 403, reason: ctx.settings.message || `${hit} is blocked` } };
  },
});
