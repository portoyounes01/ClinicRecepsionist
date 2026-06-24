// TEST-ONLY preload. On newer local Node (24/26+), the built-in fetch (undici)
// drops OpenAI SSE streams ("Premature close"); the standalone `undici` package's
// fetch works. Inject it into every OpenAI client constructor so the gym can run.
//
// Best-effort: if `undici` isn't installed (e.g. CI on an LTS Node where the
// built-in fetch is fine), this is a harmless no-op. Used via:
//   NODE_OPTIONS="--require scripts/sim/openai-fetch-shim.js" node scripts/textGym.js
let undici;
try { undici = require('undici'); } catch (_) { undici = null; }

if (undici && typeof undici.fetch === 'function') {
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    const res = orig.apply(this, [request, ...rest]);
    if (request === 'openai' && res && !res.__fetchPatched) {
      const inject = (O) => (typeof O === 'function')
        ? new Proxy(O, { construct(t, a) { const o = a[0] || {}; return Reflect.construct(t, [{ ...o, fetch: o.fetch || ((u, i) => undici.fetch(u, i)) }]); } })
        : O;
      if (res.default) res.default = inject(res.default);
      if (res.OpenAI)  res.OpenAI  = inject(res.OpenAI);
      try { res.__fetchPatched = true; } catch (_) {}
    }
    return res;
  };
}
