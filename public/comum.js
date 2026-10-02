// Ajudantes das telas novas (Performance, Análise ABC, Histórico ADS, Full): formatação,
// chamada à API e o seletor de conta do cabeçalho — iguais aos das outras telas.
const $ = (id) => document.getElementById(id);
const real = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const numero = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR'));
const pct = (n, casas = 1) => (n == null ? '—' : (n * 100).toLocaleString('pt-BR', { maximumFractionDigits: casas }) + '%');
const data = (iso) => (iso ? new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '');
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

async function api(caminho, opts) {
  const r = await fetch(caminho, opts);
  if (r.status === 401) { const j = await r.json().catch(() => ({})); if (/Sessão/.test(j.error || '')) { location.href = '/login'; return; } }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Falhou'), { status: r.status });
  return j;
}
function erroTela(msg) { const m = $('msg'); if (!m) return; m.textContent = msg; m.style.display = msg ? 'block' : 'none'; }

// variação de um número contra o anterior, como chip ▲/▼
function variacao(atual, antes, invertido = false) {
  if (!antes || atual == null) return el('span', 'chip', 'sem base');
  const d = (atual - antes) / Math.abs(antes);
  const bom = invertido ? d < 0 : d > 0;
  return el('span', 'chip ' + (Math.abs(d) < 0.005 ? '' : bom ? 'sobe' : 'desce'),
    `${d > 0 ? '▲' : d < 0 ? '▼' : '='} ${pct(Math.abs(d), 0)} vs anterior`);
}

// linha de anúncio com foto e título, para tabelas
function celulaProduto(foto, titulo, sub, link) {
  const td = el('td'); const p = el('div', 'prod');
  const im = el('img'); im.alt = ''; im.loading = 'lazy'; if (foto) im.src = foto;
  const t = el('div');
  const nome = link ? el('a', null, titulo) : el('span', null, titulo);
  if (link) { nome.href = link; nome.target = '_blank'; nome.rel = 'noopener'; }
  t.appendChild(nome); if (sub) t.appendChild(el('span', 'pequeno', sub));
  p.append(im, t); td.appendChild(p); return td;
}

// seletor de conta (cabeçalho)
(async function contas() {
  const sel = $('selConta'); if (!sel) return;
  try {
    // A opção "Amazon" é acrescentada pelo menu.js (em todas as telas).
    const { ativa, contas } = await api('/api/accounts');
    // conta de outro marketplace (Amazon, loja da Shopee): nenhuma conta do ML fica marcada
    const naAmazon = ['/amazon.html', '/amazon-anuncios.html', '/amazon-ads.html'].includes(location.pathname) || /^(amazon|shopee-\d+)$/.test(new URLSearchParams(location.search).get('conta') || '');
    sel.innerHTML = '';
    if (!contas.length) { sel.hidden = true; return; }
    for (const c of contas) { const o = el('option', null, `${c.nickname} · ${c.site_id}`); o.value = c.ml_user_id; o.selected = !naAmazon && c.ml_user_id === ativa; sel.appendChild(o); }
    sel.onchange = async () => {
      await fetch('/api/accounts/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ml_user_id: Number(sel.value) }) });
      if (naAmazon) location.href = '/'; else location.reload();
    };
  } catch { sel.hidden = true; }
})();

// botões de período (.seg com data-dias)
function periodo(segId, inicial, aoMudar) {
  const seg = $(segId);
  const marcar = (v) => { for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.dias === String(v))); };
  marcar(inicial);
  seg.onclick = (ev) => { const b = ev.target.closest('button'); if (!b) return; marcar(b.dataset.dias); aoMudar(Number(b.dataset.dias)); };
}
