// Peças com defeito nas devoluções da Shopee, Amazon, Leroy e Magalu (a mesma marcação da tela Devoluções do ML).
// blocoDefeito(p, { origem, aoSalvar }) -> elemento com uma caixa por produto do SKU (kit aberto pela tabela Produtos)
// e, com 2+ unidades, quantas daquela peça estão com defeito. "Conferir" grava (PUT /api/devolucoes/canais/defeito):
// o que não estiver marcado volta ao estoque (a partir da 1ª contagem). Usa el/real/api do comum.js.
(function(){
  const css = `
  .defeito-kit{border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin:0;min-width:0;display:grid;gap:5px;font-size:13px;max-width:460px}
  .defeito-kit legend{font-weight:700;font-size:12px;padding:0 4px}
  .defeito-kit label{display:flex;align-items:center;gap:6px;cursor:pointer;min-width:0;white-space:normal}
  .defeito-kit label input[type=checkbox]{width:16px;height:16px;flex:0 0 16px}
  .defeito-kit label b{white-space:nowrap}
  .defeito-kit .custo,.defeito-kit .sem-custo{margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums;padding-left:8px}
  .defeito-kit .sem-custo{color:var(--neg,#b91c1c)}
  .defeito-kit small{font-size:11px;color:var(--muted)}
  .defeito-kit .qtd-defeito{display:flex;align-items:center;gap:6px;font-weight:600;margin:0 0 2px 22px;cursor:default}
  .defeito-kit .qtd-defeito input{width:64px;font:inherit;font-weight:700;text-align:center;padding:2px 6px;border:1px solid var(--line);border-radius:8px}
  .defeito-kit [hidden]{display:none !important}
  .defeito-kit .pe{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .defeito-kit .ok{color:var(--pos,#0b6b33);font-weight:600}
  .defeito-kit .pendente{color:var(--alerta,#b45309);font-weight:600}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const salvos = new Map();   // chave -> quando salvou nesta tela (mostra "Salvo às…" depois de reler a lista)
  window.blocoDefeito = function(p, { origem, aoSalvar } = {}){
    const grupo = el('fieldset', 'defeito-kit');
    const pecas = p.componentes || [];
    grupo.appendChild(el('legend', null, pecas.length > 1 ? 'Quais produtos voltaram com defeito?' : 'O produto voltou com defeito?'));
    if(!pecas.length){
      grupo.appendChild(el('small', null, `SKU ${p.sku || '(vazio)'} sem produto da tabela: ligue o anúncio a um produto (tela Produtos) para conferir.`));
      return grupo;
    }
    const marcadas = new Set(p.produtos_defeito || []);
    const qd = p.qtds_defeito || {};
    const fal = p.faltam || {};
    const caixas = [], qtds = [], faltas = [];
    pecas.forEach((c, i) => {
      const lab = el('label');
      const ck = el('input'); ck.type = 'checkbox'; ck.checked = marcadas.has(i);
      lab.append(ck, el('b', null, c.sku), document.createTextNode(' ' + (c.nome || 'fora da tabela de produtos')),
        el('span', c.custo == null ? 'sem-custo' : 'custo', c.custo == null ? 'sem custo' : real(c.custo)));
      grupo.appendChild(lab); caixas.push(ck);
      if(p.quantidade > 1){
        const qt = el('label', 'qtd-defeito');
        const n = el('input'); n.type = 'number'; n.min = '1'; n.max = String(p.quantidade); n.step = '1'; n.value = String(qd[i] ?? p.quantidade);
        n.setAttribute('aria-label', `Quantas ${c.sku} com defeito`);
        qt.append(document.createTextNode('com defeito:'), n, document.createTextNode(`de ${p.quantidade}`));
        qt.hidden = !ck.checked; grupo.appendChild(qt); qtds.push(n);
        ck.addEventListener('change', () => { qt.hidden = !ck.checked; });
      }
      // o cliente não devolveu esta peça: nem estoque bom nem peças com defeito (o custo dela soma como perdida)
      const nf = el('label', 'qtd-defeito');
      const cf = el('input'); cf.type = 'checkbox'; cf.checked = !!fal[i]; cf.setAttribute('aria-label', `${c.sku} não devolvida pelo cliente`);
      nf.append(cf, document.createTextNode(' não devolvida pelo cliente'));
      let nn = null;
      if(p.quantidade > 1){
        nn = el('input'); nn.type = 'number'; nn.min = '1'; nn.max = String(p.quantidade); nn.step = '1'; nn.value = String(fal[i] || p.quantidade);
        nn.setAttribute('aria-label', `Quantas ${c.sku} não devolvidas`); nn.hidden = !cf.checked;
        const de = el('span', null, `de ${p.quantidade}`); de.hidden = !cf.checked;
        nf.append(nn, de); cf.addEventListener('change', () => { nn.hidden = de.hidden = !cf.checked; });
      }
      grupo.appendChild(nf); faltas.push({ cf, nn });
    });
    const pe = el('div', 'pe');
    const bt = el('button', 'bt', p.conferida ? 'Salvar conferência' : 'Conferir: chegou');
    bt.type = 'button';
    const dataHora = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const recente = salvos.get(p.chave);
    const situ = el('small', p.conferida ? 'ok' : 'pendente');
    if(p.conferida){
      situ.append(el('b', null, recente && Date.now() - recente < 120e3 ? `✓ Salvo às ${dataHora(recente).slice(-5)}` : `✓ Conferida em ${dataHora(p.conferida_em)}`),
        document.createTextNode((marcadas.size ? ` · peças com defeito: ${real(p.peca_defeito)}` : '') + (Object.keys(fal).length ? ` · não devolvidas: ${real(p.peca_faltando)}` : '')
          + (!marcadas.size && !Object.keys(fal).length ? ' · voltou tudo bom' : '')));
    }else situ.textContent = 'Ainda não conferida: marque o que veio com defeito e clique quando o produto chegar.';
    // o que acontece com o estoque (a mesma regra de estoque.js#linhasDeDevolucaoCanais)
    const est = el('small', p.estoque === 'volta' ? 'ok' : 'pendente',
      p.estoque === 'volta' ? (p.conferida ? (marcadas.size || Object.keys(fal).length ? 'O que não está marcado voltou ao estoque.' : 'Voltou ao estoque.') : 'Ao conferir, o que não estiver marcado volta ao estoque (com defeito vai para "Defeitos (troca)"; não devolvida não entra em nenhum).')
        : p.estoque === 'antes_contagem' ? `Conferida antes da contagem de estoque (${dataHora(p.inicio_estoque).slice(0, 5)}): já estava na prateleira contada.`
          : 'O estoque ainda não começou (falta a 1ª contagem): nada volta sozinho.');
    pe.append(bt, situ); grupo.append(pe, est);
    bt.onclick = async () => {
      const produtos = caixas.map((c, i) => (c.checked ? i : -1)).filter((i) => i >= 0);
      const q = {};
      if(qtds.length) for(const i of produtos) q[i] = Math.min(p.quantidade, Math.max(1, Math.round(Number(qtds[i].value) || p.quantidade)));
      const faltam = {};
      faltas.forEach((f, i) => { if(f.cf.checked) faltam[i] = f.nn ? Math.min(p.quantidade, Math.max(1, Math.round(Number(f.nn.value) || p.quantidade))) : p.quantidade; });
      bt.disabled = true; bt.textContent = 'Salvando…';
      try{
        await api('/api/devolucoes/canais/defeito', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chave: p.chave, sku: p.sku, quantidade: p.quantidade, data: p.data, origem, produtos, qtds: q, faltam }) });
        salvos.set(p.chave, Date.now());
        if(aoSalvar) aoSalvar();
        else { bt.disabled = false; bt.textContent = 'Salvar conferência'; situ.className = 'ok'; situ.textContent = '✓ Salvo'; }
      }catch(e){ bt.disabled = false; bt.textContent = p.conferida ? 'Salvar conferência' : 'Conferir: chegou'; situ.className = 'pendente'; situ.textContent = e.message; }
    };
    return grupo;
  };
})();
