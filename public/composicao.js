// Botão "Produtos" das telas de anúncios (ML, Shopee, Amazon, Leroy, Magalu): escolhe os produtos que formam o
// anúncio SEM mudar o SKU no marketplace. Grava a composição no painel (PUT /api/produtos/composicoes); custo, lucro,
// estoque e comandas passam a usar esses produtos. Uso: Composicao.botao(sku, { titulo, aoSalvar }) -> <button>.
(function () {
  const $c = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const pedir = async (caminho, opts) => {
    const r = await fetch(caminho, { credentials: 'same-origin', ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.erro || `erro ${r.status}`);
    return j;
  };
  const brl = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  let catalogo = null;
  async function lerCatalogo() {
    if (catalogo) return catalogo;
    try { catalogo = (await pedir('/api/produtos-custo')).produtos || []; } catch { catalogo = []; }
    let dl = document.getElementById('compCatalogo');
    if (!dl) { dl = $c('datalist'); dl.id = 'compCatalogo'; document.body.appendChild(dl); }
    dl.innerHTML = '';
    for (const p of catalogo) { const o = $c('option'); o.value = p.sku; o.label = p.nome || ''; dl.appendChild(o); }
    return catalogo;
  }
  function estilo() {
    if (document.getElementById('compEstilo')) return;
    const s = $c('style'); s.id = 'compEstilo';
    s.textContent = `.comp-fundo{position:fixed;inset:0;background:rgba(5,10,20,.55);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px}
.comp-caixa{background:var(--card,#fff);color:var(--ink,#16213a);border:1px solid var(--line,#e3e8f0);border-radius:14px;max-width:560px;width:100%;padding:18px;box-shadow:0 20px 50px rgba(0,0,0,.35);max-height:90vh;overflow:auto}
.comp-caixa h3{margin:0 0 4px;font-size:16px}.comp-caixa p{margin:0 0 10px;font-size:13px;color:var(--muted,#5f6b7f)}
.comp-lin{display:flex;gap:6px;align-items:center;margin:0 0 6px}.comp-lin input{flex:1;font:inherit;font-size:14px;padding:7px 10px;border:1px solid #d5dbe5;border-radius:8px;text-transform:uppercase;background:var(--card,#fff);color:inherit}
.comp-lin span{font-size:12px;color:var(--muted,#5f6b7f);min-width:150px}.comp-lin button{border:0;background:none;color:#b42318;font-size:18px;cursor:pointer}
.comp-acoes{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.comp-acoes button,.comp-bt{font:inherit;font-size:13px;font-weight:600;border-radius:8px;padding:6px 12px;cursor:pointer;border:1px solid #d5dbe5;background:var(--card,#fff);color:var(--ink,#16213a)}
.comp-acoes .primario{background:var(--brand,#2563eb);color:#fff;border-color:var(--brand,#2563eb)}.comp-msg{font-size:13px;margin-top:8px}.comp-msg.erro{color:#b42318}.comp-msg.ok{color:#0b6b33}
.comp-bt.pequeno{padding:3px 9px;font-size:12px}`;
    document.head.appendChild(s);
  }
  async function abrir(sku, { titulo, aoSalvar } = {}) {
    estilo();
    const fundo = $c('div', 'comp-fundo'); const cx = $c('div', 'comp-caixa'); fundo.appendChild(cx); document.body.appendChild(fundo);
    const fechar = () => fundo.remove();
    fundo.onclick = (ev) => { if (ev.target === fundo) fechar(); };
    cx.append($c('h3', null, 'Produtos do anúncio'), $c('p', null, `${titulo ? titulo + ' · ' : ''}SKU ${sku}. Escolha os produtos que vão no anúncio: o SKU no marketplace NÃO muda. Produto repetido = 2 unidades.`));
    const lista = $c('div'); cx.appendChild(lista);
    const msg = $c('div', 'comp-msg');
    let r;
    try { [r] = await Promise.all([pedir('/api/produtos/composicao?sku=' + encodeURIComponent(sku)), lerCatalogo()]); }
    catch (e) { msg.className = 'comp-msg erro'; msg.textContent = e.message; cx.appendChild(msg); return; }
    const porSku = new Map(catalogo.map((p) => [String(p.sku).toUpperCase(), p]));
    const caixas = [];
    const nova = (v = '') => {
      const lin = $c('div', 'comp-lin'); const i = $c('input'); i.setAttribute('list', 'compCatalogo'); i.placeholder = 'DQ-005'; i.value = v;
      const info = $c('span'); const pint = () => { const p = porSku.get(i.value.trim().toUpperCase()); info.textContent = p ? `${p.nome || ''} · ${brl(p.custo)}` : (i.value.trim() ? 'fora da tabela' : ''); };
      i.oninput = pint; pint();
      const x = $c('button', null, '×'); x.type = 'button'; x.title = 'Tirar'; x.onclick = () => { lin.remove(); caixas.splice(caixas.indexOf(i), 1); };
      lin.append(i, info, x); lista.appendChild(lin); caixas.push(i); return i;
    };
    (r.produtos.length ? r.produtos.map((p) => p.sku) : ['', '']).forEach((s) => nova(s));
    if (r.escolhida) cx.appendChild($c('p', null, 'Escolhidos no painel. Pelo SKU seriam: ' + (r.do_sku.map((p) => p.sku).join(' + ') || 'nenhum produto')));
    const acoes = $c('div', 'comp-acoes');
    const mais = $c('button', null, '+ produto'); mais.type = 'button'; mais.onclick = () => nova().focus();
    const salvar = $c('button', 'primario', 'Salvar'); salvar.type = 'button';
    const voltar = $c('button', null, 'Voltar ao SKU'); voltar.type = 'button'; voltar.hidden = !r.escolhida;
    const cancelar = $c('button', null, 'Fechar'); cancelar.type = 'button'; cancelar.onclick = fechar;
    acoes.append(mais, salvar, voltar, cancelar); cx.append(acoes, msg);
    const gravar = async (produtos) => {
      salvar.disabled = voltar.disabled = true; msg.className = 'comp-msg'; msg.textContent = 'Salvando…';
      try {
        const x = await pedir('/api/produtos/composicoes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku, produtos }) });
        const sem = (x.composicao?.produtos || []).filter((p) => p.custo == null).map((p) => p.sku);
        msg.className = 'comp-msg ok';
        msg.textContent = produtos.length ? 'Salvo: ' + (x.composicao?.produtos || []).map((p) => p.sku).join(' + ') + (sem.length ? ` · sem custo na tabela: ${sem.join(', ')}` : '') : 'Pronto: o anúncio volta a usar o SKU.';
        if (aoSalvar) aoSalvar(x);
        setTimeout(fechar, 1200);
      } catch (e) { msg.className = 'comp-msg erro'; msg.textContent = e.message; }
      salvar.disabled = voltar.disabled = false;
    };
    salvar.onclick = () => {
      const ps = caixas.map((i) => i.value.trim().toUpperCase()).filter(Boolean);
      if (!ps.length) { msg.className = 'comp-msg erro'; msg.textContent = 'Informe pelo menos um produto.'; return; }
      gravar(ps);
    };
    voltar.onclick = () => { if (confirm('Apagar a escolha? O painel volta a ler os produtos pelo SKU do anúncio.')) gravar([]); };
    caixas[0]?.focus();
  }
  function botao(sku, opcoes = {}) {
    estilo();
    const b = $c('button', 'comp-bt' + (opcoes.pequeno === false ? '' : ' pequeno'), opcoes.rotulo || 'Produtos'); b.type = 'button';
    b.title = 'Escolher os produtos deste anúncio sem mudar o SKU no marketplace';
    if (!sku) { b.disabled = true; b.title = 'Anúncio sem SKU'; }
    b.onclick = (ev) => { ev.stopPropagation(); abrir(sku, opcoes); };
    return b;
  }
  window.Composicao = { abrir, botao };
})();
