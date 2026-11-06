// Componentes comuns de todas as telas (carregado pelo public/menu.js; aparência em public/ds.css):
//   ui.toast(texto, 'ok'|'erro'|'aviso')      aviso rápido no canto, some sozinho
//   await ui.confirmar({ titulo, texto, ok, perigo })   confirmação dentro da página (true/false)
//   ui.moeda(n), ui.numero(n), ui.pct(n)       formatos do Brasil
// e, sozinho: ordenar as tabelas clicando no cabeçalho e a dica (tooltip) dos botões com data-dica.
// Só aparência e conveniência: nenhuma regra de negócio, nenhuma chamada à API.
(function () {
  if (window.ui) return;
  const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const NUM = new Intl.NumberFormat('pt-BR');
  const ui = {
    moeda: (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : BRL.format(Number(n))),
    numero: (n, casas = 0) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: casas, minimumFractionDigits: casas })),
    pct: (n, casas = 1) => (n == null || !Number.isFinite(Number(n)) ? '—' : (Number(n) * 100).toLocaleString('pt-BR', { maximumFractionDigits: casas, minimumFractionDigits: casas }) + '%'),
  };
  void NUM;

  // ---------- aviso rápido ----------
  ui.toast = (texto, tipo = 'ok', ms = 4200) => {
    let box = document.querySelector('.ds-toasts');
    if (!box) { box = document.createElement('div'); box.className = 'ds-toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    const t = document.createElement('div'); t.className = 'ds-toast ' + tipo; t.textContent = texto;
    box.appendChild(t);
    setTimeout(() => { t.classList.add('saindo'); setTimeout(() => t.remove(), 220); }, ms);
    return t;
  };

  // ---------- confirmação (o navegador do painel não usa confirm()) ----------
  ui.confirmar = ({ titulo = 'Confirmar', texto = '', ok = 'Confirmar', cancelar = 'Cancelar', perigo = false } = {}) => new Promise((resolve) => {
    const d = document.createElement('dialog'); d.className = 'ds-confirmar';
    d.style.cssText = 'max-width:min(460px,calc(100vw - 32px));padding:0';
    const corpo = document.createElement('div'); corpo.style.cssText = 'padding:20px 22px 8px';
    const h = document.createElement('h2'); h.style.cssText = 'margin:0 0 8px;font-size:17px'; h.textContent = titulo;
    const p = document.createElement('p'); p.style.cssText = 'margin:0;color:var(--muted);font-size:14px;white-space:pre-line'; p.textContent = texto;
    corpo.append(h, p);
    const pe = document.createElement('div'); pe.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:16px 22px 20px';
    const nao = document.createElement('button'); nao.type = 'button'; nao.className = 'bt'; nao.textContent = cancelar;
    const sim = document.createElement('button'); sim.type = 'button'; sim.className = perigo ? 'bt perigo' : 'bt primario'; sim.textContent = ok;
    pe.append(nao, sim); d.append(corpo, pe); document.body.appendChild(d);
    const fim = (v) => { d.close(); d.remove(); resolve(v); };
    nao.onclick = () => fim(false); sim.onclick = () => fim(true);
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); fim(false); });
    d.showModal(); (perigo ? nao : sim).focus();
  });

  // ---------- ordenar tabelas pelo cabeçalho ----------
  // Vale para tabela com <thead> e linhas simples (sem colspan/rowspan no corpo) e cabeçalho que a tela
  // não ordena por conta própria (th.onclick). Ordena as linhas que estão na tela; a tela redesenhou = volta ao normal.
  const valorDe = (td) => {
    if (!td) return '';
    if (td.dataset && td.dataset.valor != null && td.dataset.valor !== '') return Number(td.dataset.valor);
    const campo = td.querySelector('input,select'); const txt = (campo ? campo.value : td.textContent).trim();
    if (!txt || txt === '—' || txt === '-') return null;
    const data = /^(\d{2})\/(\d{2})(?:\/(\d{2,4}))?(?:\s+(\d{2}):(\d{2}))?/.exec(txt);
    if (data) return Number((data[3] ? (data[3].length === 2 ? '20' + data[3] : data[3]) : '2000') + data[2] + data[1] + (data[4] || '00') + (data[5] || '00'));
    const n = txt.replace(/\s/g, '').replace(/R\$|US\$/g, '');
    if (/^[-+−]?[\d.]*\d(,\d+)?%?(x|un\.?|pç|dias?)?$/i.test(n)) return Number(n.replace('−', '-').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
    return txt.toLocaleLowerCase('pt-BR');
  };
  let ordenando = false;
  function ordenar(table, th, idx) {
    const corpo = table.tBodies[0]; if (!corpo) return;
    const linhas = [...corpo.rows];
    if (linhas.some((tr) => [...tr.cells].some((c) => c.colSpan > 1 || c.rowSpan > 1))) return;
    const dir = th.getAttribute('aria-sort') === 'descending' ? 'ascending' : 'descending';
    for (const o of table.tHead.querySelectorAll('th[aria-sort]')) o.removeAttribute('aria-sort');
    th.setAttribute('aria-sort', dir);
    const fixas = linhas.filter((tr) => tr.classList.contains('total') || tr.classList.contains('soma'));
    const mover = linhas.filter((tr) => !fixas.includes(tr));
    const m = dir === 'ascending' ? 1 : -1;
    mover.sort((a, b) => {
      const x = valorDe(a.cells[idx]), y = valorDe(b.cells[idx]);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * m;
      return String(x).localeCompare(String(y), 'pt-BR', { numeric: true }) * m;
    });
    ordenando = true;
    corpo.append(...mover, ...fixas);
    queueMicrotask(() => { ordenando = false; });
  }
  function prepararTabela(table) {
    if (table.dataset.dsOrd || table.closest('[data-sem-ordenar],.cmdk') || table.hasAttribute('data-sem-ordenar')) return;
    const cab = table.tHead; const corpo = table.tBodies[0];
    if (!cab || !corpo || corpo.rows.length < 2) return;
    const linha = cab.rows[cab.rows.length - 1];
    if (!linha || [...linha.cells].some((c) => c.colSpan > 1)) return;
    if ([...corpo.rows].some((tr) => [...tr.cells].some((c) => c.colSpan > 1 || c.rowSpan > 1))) return;
    table.dataset.dsOrd = '1';
    [...linha.cells].forEach((th, idx) => {
      if (th.tagName !== 'TH' || th.onclick || th.querySelector('input,button,select,a') || !th.textContent.trim()) return;
      th.classList.add('ds-ordena'); th.tabIndex = 0; th.title = th.title || 'Ordenar por esta coluna';
      th.addEventListener('click', () => ordenar(table, th, idx));
      th.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ordenar(table, th, idx); } });
    });
    // a tela trocou as linhas: a seta de ordem sai (a ordem é a da tela de novo)
    new MutationObserver(() => { if (!ordenando) for (const o of table.querySelectorAll('th[aria-sort]')) o.removeAttribute('aria-sort'); })
      .observe(corpo, { childList: true });
  }
  let agendado = null;
  const varrer = () => { agendado = null; for (const t of document.querySelectorAll('main table:not([data-ds-ord])')) prepararTabela(t); };
  new MutationObserver(() => { if (!agendado) agendado = setTimeout(varrer, 250); }).observe(document.body, { childList: true, subtree: true });
  varrer();

  // ---------- dica dos botões (data-dica) ----------
  let dica = null;
  const tirarDica = () => { dica?.remove(); dica = null; };
  const porDica = (el) => {
    tirarDica();
    const txt = el.getAttribute('data-dica'); if (!txt) return;
    // no menu aberto o próprio texto do item já aparece: só mostra a dica no menu recolhido ou nos botões só de ícone
    if (el.closest('.lateral') && document.documentElement.dataset.menu !== 'recolhido' && !el.closest('.sb-acoes')) return;
    dica = document.createElement('div'); dica.className = 'ds-dica'; dica.textContent = txt; document.body.appendChild(dica);
    const r = el.getBoundingClientRect(), d = dica.getBoundingClientRect();
    const naLateral = !!el.closest('.lateral') && document.documentElement.dataset.menu === 'recolhido';
    let x = naLateral ? r.right + 8 : r.left + r.width / 2 - d.width / 2, y = naLateral ? r.top + r.height / 2 - d.height / 2 : r.top - d.height - 8;
    if (y < 4) y = r.bottom + 8;
    x = Math.max(6, Math.min(x, innerWidth - d.width - 6));
    dica.style.left = x + 'px'; dica.style.top = y + 'px';
  };
  document.addEventListener('mouseover', (ev) => { const el = ev.target.closest?.('[data-dica]'); if (el) porDica(el); });
  document.addEventListener('mouseout', (ev) => { if (ev.target.closest?.('[data-dica]')) tirarDica(); });
  document.addEventListener('focusin', (ev) => { const el = ev.target.closest?.('[data-dica]'); if (el && el.matches(':focus-visible')) porDica(el); else tirarDica(); });
  addEventListener('scroll', tirarDica, true);

  window.ui = ui;
})();
