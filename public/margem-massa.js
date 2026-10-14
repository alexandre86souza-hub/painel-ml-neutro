// "Preço pela margem" em massa nas telas de anúncios da Shopee, Amazon, Leroy e Magalu (o ML tem o seu, com a tarifa
// real da faixa de preço). A tela entrega os anúncios do filtro atual e a conta de cada canal; aqui: margem desejada,
// prévia (preço atual -> novo, margem hoje -> nova), marca/desmarca e aplica só nos marcados, depois de confirmar.
// MargemMassa.abrir({ canal, itens: [{ chave, titulo, sub, preco, precoPara(m), margemEm(p) }], aplicar(lista, andamento) })
(function () {
  const $m = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const brl = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  const pc = (v) => (v == null || !isFinite(v) ? '—' : (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%');
  function estilo() {
    if (document.getElementById('mmEstilo')) return;
    const s = $m('style'); s.id = 'mmEstilo';
    s.textContent = `.mm-fundo{position:fixed;inset:0;background:rgba(5,10,20,.55);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px}
.mm-caixa{background:var(--card,#fff);color:var(--ink,#16213a);border:1px solid var(--line,#e3e8f0);border-radius:14px;max-width:980px;width:100%;padding:18px;box-shadow:0 20px 50px rgba(0,0,0,.35);max-height:92vh;display:flex;flex-direction:column}
.mm-caixa h3{margin:0 0 4px;font-size:16px}.mm-caixa>p{margin:0 0 10px;font-size:13px;color:var(--muted,#5f6b7f)}
.mm-form{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px;font-size:13px}.mm-form label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted,#5f6b7f)}
.mm-form input{width:100px;font:inherit;font-size:14px;padding:7px 9px;border:1px solid #d5dbe5;border-radius:8px;background:var(--card,#fff);color:inherit}
.mm-form button{font:inherit;font-size:13px;font-weight:600;border-radius:8px;padding:7px 12px;cursor:pointer;border:1px solid #d5dbe5;background:var(--card,#fff);color:var(--ink,#16213a)}
.mm-form .primario{background:var(--brand,#2563eb);color:#fff;border-color:var(--brand,#2563eb)}.mm-form button:disabled{opacity:.5;cursor:default}
.mm-rol{overflow:auto;flex:1 1 auto;border-top:1px solid var(--line,#e3e8f0)}.mm-rol table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
.mm-rol th,.mm-rol td{padding:6px;border-bottom:1px solid var(--line,#e3e8f0);text-align:left;vertical-align:top}.mm-rol th{font-size:12px;color:var(--muted,#5f6b7f);position:sticky;top:0;background:var(--card,#fff)}
.mm-rol td.n{text-align:right;white-space:nowrap}.mm-rol .sub{font-size:11px;color:var(--muted,#5f6b7f)}.mm-erro{color:#b42318}.mm-ok{color:#0b6b33}.mm-info{font-size:13px;color:var(--muted,#5f6b7f)}`;
    document.head.appendChild(s);
  }
  function abrir({ canal, itens, aplicar, nota }) {
    estilo();
    const fundo = $m('div', 'mm-fundo'); const cx = $m('div', 'mm-caixa'); fundo.appendChild(cx); document.body.appendChild(fundo);
    cx.append($m('h3', null, 'Preço pela margem — ' + canal),
      $m('p', null, `${itens.length} anúncio(s) do filtro da tela. Preço novo = o que dá a margem escolhida com a taxa média do canal, o custo dos produtos, a embalagem e o imposto. ${nota || ''}`));
    const f = $m('form', 'mm-form');
    const lab = $m('label', null, 'Margem de lucro desejada (%)'); const inp = $m('input'); inp.type = 'number'; inp.step = '0.5'; inp.min = '0'; inp.max = '80'; inp.value = '20'; lab.appendChild(inp);
    const calc = $m('button', null, 'Calcular'); calc.type = 'submit';
    const ap = $m('button', 'primario', 'Aplicar nos marcados'); ap.type = 'button'; ap.disabled = true;
    const fe = $m('button', null, 'Fechar'); fe.type = 'button'; fe.onclick = () => fundo.remove();
    const info = $m('span', 'mm-info');
    f.append(lab, calc, ap, fe, info); cx.appendChild(f);
    const rol = $m('div', 'mm-rol'); cx.appendChild(rol);
    let linhas = [];
    const contar = () => { const n = linhas.filter((l) => l.ck?.checked && !l.ck.disabled).length; ap.disabled = !n; ap.textContent = n ? `Aplicar em ${n} anúncio(s)` : 'Aplicar nos marcados'; };
    f.onsubmit = (ev) => {
      ev.preventDefault();
      const m = Number(String(inp.value).replace(',', '.')) / 100;
      const t = $m('table'); const cab = $m('tr');
      for (const h of ['', 'Anúncio', 'Preço atual', 'Margem hoje', 'Preço novo', 'Margem nova', '']) cab.appendChild($m('th', null, h));
      const th = $m('thead'); th.appendChild(cab); t.appendChild(th); const tb = $m('tbody'); t.appendChild(tb);
      linhas = itens.map((it) => {
        const tr = $m('tr'); const novo = it.precoPara(m); const sit = $m('td');
        const c0 = $m('td'); let ck = null;
        if (novo == null) { sit.textContent = it.motivo || 'sem custo ou sem taxa: não dá para calcular'; sit.className = 'mm-erro'; }
        else if (Math.abs(novo - (it.preco || 0)) < 0.01) sit.textContent = 'já está no preço';
        else { ck = $m('input'); ck.type = 'checkbox'; ck.checked = true; ck.onchange = contar; c0.appendChild(ck);
          sit.textContent = (novo > it.preco ? '▲ sobe ' : '▼ desce ') + pc(Math.abs(novo / it.preco - 1)); }
        const c1 = $m('td'); c1.append($m('b', null, it.titulo || it.chave), $m('br'), $m('span', 'sub', it.sub || it.chave));
        tr.append(c0, c1, $m('td', 'n', brl(it.preco)), $m('td', 'n', pc(it.margemEm(it.preco))), $m('td', 'n', brl(novo)), $m('td', 'n', pc(novo != null ? it.margemEm(novo) : null)), sit);
        tb.appendChild(tr);
        return { it, novo, ck, sit };
      });
      rol.innerHTML = ''; rol.appendChild(t);
      info.textContent = `${linhas.filter((l) => l.ck).length} com preço novo · desmarque os que não quer mudar.`;
      contar();
    };
    ap.onclick = async () => {
      const esc = linhas.filter((l) => l.ck?.checked && !l.ck.disabled);
      if (!esc.length || !confirm(`Mudar o preço de ${esc.length} anúncio(s) na ${canal}?\n\nMuda de verdade na loja. Anúncio em promoção pode sair dela.`)) return;
      ap.disabled = calc.disabled = true;
      let ok = 0, falhas = 0;
      try {
        const res = await aplicar(esc.map((l) => ({ item: l.it, preco: l.novo })), (feitos) => { info.textContent = `Aplicando… ${feitos} de ${esc.length}`; });
        for (const r of res) {
          const l = esc.find((x) => x.it.chave === r.chave); if (!l) continue;
          if (r.ok) { ok++; l.sit.textContent = r.texto || 'preço mudado'; l.sit.className = 'mm-ok'; l.ck.checked = false; l.ck.disabled = true; }
          else { falhas++; l.sit.textContent = 'não mudou: ' + r.erro; l.sit.className = 'mm-erro'; }
        }
      } catch (e) { info.textContent = 'Parou: ' + e.message; }
      info.textContent = `${ok} preço(s) mudado(s)` + (falhas ? `, ${falhas} não mudaram (veja o motivo).` : '.');
      calc.disabled = false; contar();
    };
    inp.focus();
  }
  // aplica um por um (3 ao mesmo tempo) com a função do canal; devolve [{ chave, ok, erro, texto }]
  async function umPorUm(lista, fn, andamento, paralelo = 3) {
    const out = []; let prox = 0, feitos = 0;
    const trab = async () => { for (let k = prox++; k < lista.length; k = prox++) {
      const x = lista[k];
      try { const t = await fn(x); out.push({ chave: x.item.chave, ok: true, texto: t || null }); } catch (e) { out.push({ chave: x.item.chave, ok: false, erro: e.message }); }
      andamento?.(++feitos);
    } };
    await Promise.all(Array.from({ length: paralelo }, trab));
    return out;
  }
  // Célula "Novo preço" de UM anúncio (Leroy e Magalu; Shopee e Amazon têm a sua igual): preço de venda OU margem
  // desejada (%), prévia do lucro, confirmação e salvar(v) do canal (devolve o texto do aviso).
  // MargemMassa.celula({ nome, canal, preco, precoPara(m), estimar(p) -> {lucro, margem}, salvar(v), aviso(t, tipo), extra })
  function celula({ nome, canal, preco, precoPara, estimar, salvar, aviso, extra, bloqueio }) {
    if (!document.getElementById('mmEstiloCel')) {
      const s = $m('style'); s.id = 'mmEstiloCel';
      s.textContent = `.mm-cel{display:flex;gap:6px;align-items:center}.mm-cel input{width:92px;font:inherit;font-size:14px;padding:6px 8px;border:1px solid #d5dbe5;border-radius:8px;background:var(--card,#fff);color:inherit;text-align:right}
.mm-cel input.margem{width:62px}.mm-cel button{white-space:nowrap;font:inherit;font-size:13px;font-weight:600;border-radius:8px;padding:6px 10px;cursor:pointer;border:1px solid #d5dbe5;background:var(--card,#fff);color:inherit}
.mm-cel button:disabled{opacity:.5;cursor:default}.mm-prev{display:block;font-size:12px;color:var(--muted,#5f6b7f);margin-top:3px}.mm-prev.neg{color:#b42318}`;
      document.head.appendChild(s);
    }
    const td = $m('td');
    if (bloqueio) { td.appendChild($m('span', 'mm-prev', bloqueio)); return td; }
    const ler = (t) => Number(String(t).replace(/\s|R\$/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    const cx = $m('div', 'mm-cel');
    const inp = $m('input'); inp.type = 'text'; inp.inputMode = 'decimal'; inp.placeholder = preco != null ? String(preco).replace('.', ',') : '0,00';
    inp.setAttribute('aria-label', 'Novo preço de ' + nome);
    const inpM = $m('input', 'margem'); inpM.type = 'text'; inpM.inputMode = 'decimal'; inpM.placeholder = 'ou %';
    inpM.title = 'Margem de lucro desejada (%): o painel calcula o preço'; inpM.setAttribute('aria-label', 'Margem desejada de ' + nome);
    if (precoPara(0.1) == null) { inpM.disabled = true; inpM.title = 'Sem custo do produto ou sem taxa: não dá para calcular pela margem'; }
    const bt = $m('button', null, 'Salvar'); bt.type = 'button'; bt.disabled = true;
    const prev = $m('span', 'mm-prev');
    const txt = (e) => (e ? `${brl(e.lucro)} · ${pc(e.margem)}` : '');
    inp.oninput = () => {
      const v = ler(inp.value); const ok = inp.value.trim() && Number.isFinite(v) && v > 0;
      bt.disabled = !ok; prev.className = 'mm-prev';
      if (!ok) { prev.textContent = ''; return; }
      const e = estimar(v);
      prev.textContent = e ? `fica ${txt(e)}` : 'sem custo ou taxa para estimar';
      if (e && e.lucro < 0) prev.className = 'mm-prev neg';
    };
    inpM.oninput = () => {
      const m = ler(inpM.value.replace('%', ''));
      if (!inpM.value.trim() || !Number.isFinite(m)) return;
      const p = precoPara(m / 100);
      if (p == null) { inp.value = ''; inp.oninput(); prev.textContent = 'margem alta demais para os custos deste produto'; prev.className = 'mm-prev neg'; return; }
      inp.value = p.toFixed(2).replace('.', ','); inp.oninput();
    };
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !bt.disabled) bt.click(); });
    bt.onclick = async () => {
      const v = ler(inp.value); const e = estimar(v);
      if (!confirm(`Mudar o preço na ${canal}?\n\n${nome}\n\nDe ${brl(preco)} para ${brl(v)}` + (e ? `\nLucro estimado: ${txt(e)}` : '') + (extra ? `\n\n${extra}` : ''))) return;
      bt.disabled = true; bt.textContent = 'Enviando…';
      try { const t = await salvar(v); inp.value = ''; inpM.value = ''; prev.textContent = ''; aviso?.(t, 'ok'); }
      catch (err) { aviso?.(`Não mudou o preço de ${nome}: ${err.message}`); bt.disabled = false; }
      bt.textContent = 'Salvar';
    };
    cx.append(inp, inpM, bt); td.append(cx, prev);
    return td;
  }
  // algum campo de preço digitado na tela (não repintar por cima)
  const editando = () => [...document.querySelectorAll('.mm-cel input')].some((x) => x.value.trim());

  window.MargemMassa = { abrir, umPorUm, celula, editando };
})();
