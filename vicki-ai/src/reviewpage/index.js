// ============================================================
// VICKI AI — Hosted Review Page (lifecycle)
//
//   GET  /review/:token        -> star-rating form
//   POST /review/:token        -> submit { rating, comment }
//
// Gating (per product spec):
//   >= 4 stars -> "thank you" page that copies the comment to the
//                 clipboard and forwards to the clinic's Google review URL.
//   <  4 stars -> apology page; receptionist already notified server-side.
//
// Self-contained inline HTML/CSS (no build step). Mounted additively.
// ============================================================

const express = require('express');
const reviews = require('../lifecycle/reviews');
const { getDefaultClinic } = require('../clinics/registry');

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function pageShell(title, body) {
  return `<!doctype html><html lang="pt"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --accent:#0f766e; --bg:#f7fafc; --ink:#1a202c; }
  *{box-sizing:border-box} body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:var(--bg);color:var(--ink);display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
  .card{background:#fff;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.08);max-width:440px;width:100%;padding:32px;text-align:center}
  h1{font-size:1.35rem;margin:0 0 6px} p{color:#4a5568;line-height:1.5}
  .stars{display:flex;justify-content:center;gap:8px;margin:22px 0;font-size:2.4rem;cursor:pointer}
  .stars span{filter:grayscale(1);opacity:.45;transition:.15s} .stars span.on{filter:none;opacity:1;transform:scale(1.08)}
  textarea{width:100%;min-height:96px;border:1px solid #e2e8f0;border-radius:10px;padding:12px;font:inherit;resize:vertical;margin-top:8px}
  button{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:13px 20px;font-size:1rem;font-weight:600;cursor:pointer;width:100%;margin-top:16px}
  button:disabled{opacity:.5;cursor:not-allowed} .muted{font-size:.85rem;color:#718096;margin-top:14px}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function mount(app) {
  // ── Render form ───────────────────────────────────────────────────────────
  app.get('/review/:token', (req, res) => {
    const clinic = getDefaultClinic();
    const token = esc(req.params.token);
    res.type('html').send(pageShell('A sua opinião', `
      <h1>Como correu a sua visita${clinic?.name ? ` ao ${esc(clinic.name)}` : ''}?</h1>
      <p>A sua opinião ajuda-nos a melhorar.</p>
      <div class="stars" id="stars">
        ${[1,2,3,4,5].map(i => `<span data-v="${i}">★</span>`).join('')}
      </div>
      <textarea id="comment" placeholder="Conte-nos como foi (opcional)…"></textarea>
      <button id="send" disabled>Enviar</button>
      <div class="muted">Obrigado pelo seu tempo.</div>
      <script>
        var rating=0;
        var stars=[].slice.call(document.querySelectorAll('#stars span'));
        function paint(n){stars.forEach(function(s,i){s.classList.toggle('on', i<n);});}
        stars.forEach(function(s){
          s.addEventListener('mouseenter',function(){paint(+s.dataset.v);});
          s.addEventListener('click',function(){rating=+s.dataset.v;paint(rating);document.getElementById('send').disabled=false;});
        });
        document.getElementById('stars').addEventListener('mouseleave',function(){paint(rating);});
        document.getElementById('send').addEventListener('click',function(){
          var btn=this; btn.disabled=true; btn.textContent='A enviar…';
          fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({rating:rating,comment:document.getElementById('comment').value})})
            .then(function(r){return r.json();})
            .then(function(d){
              if(d.gate==='google'){
                try{ if(d.comment) navigator.clipboard.writeText(d.comment); }catch(e){}
                document.querySelector('.card').innerHTML=
                  '<h1>Obrigado! ⭐</h1><p>Copiámos o seu comentário. Vamos abri-lo no Google — basta colar e publicar.</p>'+
                  '<button id="go">Abrir o Google</button>';
                var go=function(){ if(d.googleUrl) location.href=d.googleUrl; };
                document.getElementById('go').addEventListener('click',go);
                setTimeout(go,1500);
              } else if(d.gate==='apology'){
                document.querySelector('.card').innerHTML=
                  '<h1>Lamentamos imenso 🙏</h1><p>A sua opinião é muito valiosa. A nossa equipa foi informada e vai entrar em contacto consigo.</p>';
              } else {
                document.querySelector('.card').innerHTML='<h1>Obrigado!</h1><p>Recebemos a sua resposta.</p>';
              }
            })
            .catch(function(){ btn.disabled=false; btn.textContent='Enviar'; alert('Ocorreu um erro. Tente novamente.'); });
        });
      </script>
    `));
  });

  // ── Submit ────────────────────────────────────────────────────────────────
  app.post('/review/:token', express.json(), async (req, res) => {
    try {
      const result = await reviews.submitReview(req.params.token, req.body?.rating, req.body?.comment);
      if (!result.ok) return res.status(result.notFound ? 404 : 400).json({ ok: false });
      res.json(result);
    } catch (e) {
      console.error('[Review] submit error:', e.message);
      res.status(500).json({ ok: false });
    }
  });

  console.log('[Lifecycle] Routes mounted: /review/:token');
}

module.exports = { mount };
