// Botão "Nota de devolução" das telas de devoluções (ML, Shopee, Amazon, Leroy, Magalu): abre uma janela com a nota de venda
// (itens), a natureza de operação e as quantidades que voltaram; gera a devolução PENDENTE no Bling e depois emite. Rotas em
// devolucao-nf.js (só o administrador). Uso: elemento.appendChild(botaoNotaDevolucao({ canal: 'ml', pedido: '200…' }))
(function(){
  const css = document.createElement('style');
  css.textContent = `
    .nfdev-bt{font:inherit;font-size:12px;font-weight:600;padding:5px 10px;border:1px solid var(--line);border-radius:8px;background:none;color:var(--ink);cursor:pointer}
    dialog.nfdev{width:min(760px,calc(100vw - 32px));padding:18px 20px}
    dialog.nfdev h2{margin:0 0 4px;font-size:18px}
    dialog.nfdev .sub{font-size:12px;color:var(--muted)}
    dialog.nfdev table{width:100%;border-collapse:collapse;font-size:13px;margin:10px 0}
    dialog.nfdev th,dialog.nfdev td{border-bottom:1px solid var(--line);padding:6px;text-align:left;vertical-align:middle}
    dialog.nfdev th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
    dialog.nfdev input.q{width:70px}
    dialog.nfdev .linha{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0}
    dialog.nfdev select{max-width:100%}
    dialog.nfdev .acoes{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px}
    dialog.nfdev .msg{font-size:13px;margin-top:8px}
    dialog.nfdev .msg.erro{color:var(--err)}
    dialog.nfdev .msg.ok{color:var(--ok);font-weight:600}
    dialog.nfdev .rolar{overflow-x:auto}
    dialog.nfdev .ml-box{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:10px 0;display:grid;gap:8px;justify-items:start}`;
  document.head.appendChild(css);
  const mk = (t, c, x) => { const e = document.createElement(t); if(c) e.className = c; if(x != null) e.textContent = x; return e; };
  const reais = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const dataBr = (s) => (s ? String(s).slice(0, 10).split('-').reverse().join('/') : '');
  const json = async (r) => { const j = await r.json().catch(() => ({})); if(!r.ok) throw new Error(j.error || j.erro || ('HTTP ' + r.status)); return j; };
  const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json);

  async function abrir(alvo){
    const dl = mk('dialog', 'nfdev'); document.body.appendChild(dl);
    const fechar = () => { dl.close(); dl.remove(); };
    dl.addEventListener('close', () => dl.remove());
    const corpo = mk('div'); dl.appendChild(corpo);
    const msg = mk('div', 'msg');
    dl.showModal();

    async function carregar(chave){
      corpo.innerHTML = ''; corpo.appendChild(mk('p', 'sub', 'Lendo a nota de venda…'));
      let p;
      try{ p = await fetch(`/api/devolucao-nf/previa?canal=${encodeURIComponent(alvo.canal)}&pedido=${encodeURIComponent(alvo.pedido)}${chave ? '&chave=' + chave : ''}`).then(json); }
      catch(e){ return pedirChave(e.message); }
      desenhar(p, chave);
    }

    // não achou a venda: o vendedor cola a chave de acesso da nota de venda
    function pedirChave(motivo){
      corpo.innerHTML = '';
      corpo.appendChild(mk('h2', null, `Nota de devolução · pedido ${alvo.pedido}`));
      corpo.appendChild(mk('p', 'msg erro', motivo));
      const l = mk('div', 'linha'), inp = mk('input'); inp.placeholder = 'Chave de acesso da nota de venda (44 números)'; inp.style.flex = '1 1 320px';
      const b = mk('button', 'bt primario', 'Procurar'); b.type = 'button'; b.onclick = () => carregar(inp.value.replace(/\D/g, ''));
      l.append(inp, b); corpo.appendChild(l);
      const ac = mk('div', 'acoes'), f = mk('button', 'bt', 'Fechar'); f.type = 'button'; f.onclick = fechar; ac.appendChild(f); corpo.appendChild(ac);
    }

    function desenhar(p, chave){
      corpo.innerHTML = '';
      corpo.appendChild(mk('h2', null, `Nota de devolução · ${p.loja} · pedido ${p.pedido}`));
      corpo.appendChild(mk('div', 'sub', `Venda: NF-e ${p.venda.numero} série ${p.venda.serie} de ${dataBr(p.venda.emissao)} (${p.origem}) · ${p.venda.cliente || ''} · sai pelo Bling ${p.conta_bling === '1' ? 'AMG' : 'Primor'} (conta ${p.conta_bling})`));
      const ac = mk('div', 'acoes'), f = mk('button', 'bt', 'Fechar'); f.type = 'button'; f.onclick = fechar;

      // já gerada pelo painel: mostra e deixa emitir
      if(p.gerada && !p.gerada.cancelada){
        corpo.appendChild(mk('p', 'msg' + ([5, 6, 7].includes(p.gerada.situacao) ? ' ok' : ''), `Nota de devolução nº ${p.gerada.numero || '?'} já gerada no Bling: ${p.gerada.situacao_nome}.`));
        if(p.gerada.situacao === 1 || p.gerada.situacao === 4){
          if(p.gerada.situacao === 4) corpo.appendChild(mk('p', 'msg erro', 'A Sefaz rejeitou: veja o motivo e corrija no Bling, depois emita de novo aqui.'));
          ac.appendChild(botaoEmitir(p, msg));
        }
        ac.appendChild(f); corpo.append(msg, ac); return;
      }
      // venda pelo Faturador do ML: a devolução pode sair no próprio ML (a API não emite; o painel abre a tela do ML no pedido)
      if(p.ml_emitir){
        const box = mk('div', 'ml-box');
        box.appendChild(mk('b', null, 'Pelo Faturador do Mercado Livre (recomendado para venda do ML)'));
        box.appendChild(mk('div', 'sub', 'O ML não deixa emitir a devolução pela API: o painel abre a tela de devolução do ML já neste pedido; lá você confere as unidades e o CST e clica em "Emitir NF-e de devolução". Use UM caminho só: ou o ML, ou o Bling abaixo.'));
        const a = mk('a', 'bt primario', 'Abrir a emissão no Mercado Livre ↗'); a.href = p.ml_emitir; a.target = '_blank'; a.rel = 'noopener';
        box.appendChild(a);
        corpo.appendChild(box);
        corpo.appendChild(mk('p', null, 'Ou pelo Bling:'));
      }
      if(p.gerada?.cancelada) corpo.appendChild(mk('p', 'sub', `A devolução anterior (nº ${p.gerada.numero || '?'}) foi cancelada: dá para gerar outra.`));

      const rolar = mk('div', 'rolar'), t = mk('table'), h = mk('tr');
      for(const x of ['Item da venda', 'NCM', 'Vendido', 'Valor un.', 'Volta']) h.appendChild(mk('th', null, x));
      t.appendChild(h);
      const qtds = [];
      const total = mk('b');
      const somar = () => { total.textContent = reais(p.venda.itens.reduce((s, it, i) => s + it.unitario * (Number(qtds[i].value) || 0), 0)); };
      p.venda.itens.forEach((it) => {
        const tr = mk('tr'), q = mk('input', 'q'); q.type = 'number'; q.min = '0'; q.max = String(it.quantidade); q.step = 'any'; q.value = String(it.quantidade);
        q.oninput = somar; qtds.push(q);
        const td0 = mk('td'); td0.append(mk('div', null, it.descricao), mk('div', 'sub', it.codigo || ''));
        const tdQ = mk('td'); tdQ.appendChild(q);
        tr.append(td0, mk('td', null, it.ncm || '—'), mk('td', null, `${it.quantidade} ${it.unidade || ''}`), mk('td', null, reais(it.unitario)), tdQ);
        t.appendChild(tr);
      });
      rolar.appendChild(t); corpo.appendChild(rolar);
      const lt = mk('div', 'linha'); lt.append(mk('span', null, 'Valor dos itens que voltam:'), total); corpo.appendChild(lt); somar();

      const ln = mk('div', 'linha'), lab = mk('label', null, 'Natureza de operação '), sel = mk('select');
      sel.appendChild(Object.assign(mk('option', null, '— escolha —'), { value: '' }));
      for(const z of p.naturezas){ const o = mk('option', null, z.descricao); o.value = z.id; sel.appendChild(o); }
      if(p.natureza_sugerida) sel.value = String(p.natureza_sugerida);
      lab.appendChild(sel); ln.appendChild(lab); corpo.appendChild(ln);
      if(!p.naturezas.some((z) => /devolu/i.test(z.descricao))) corpo.appendChild(mk('p', 'msg erro', 'Esta conta do Bling não tem natureza de operação de devolução: crie "Devolução de venda" no Bling (Preferências → Naturezas de operação) com o CFOP 1202/2202 e clique em Fechar e abra de novo.'));
      corpo.appendChild(mk('p', 'sub', 'A nota é gerada PENDENTE no Bling: o CFOP e os impostos vêm da natureza escolhida. Confira lá se quiser; a emissão é no botão seguinte.'));

      const g = mk('button', 'bt primario', 'Gerar nota de devolução no Bling'); g.type = 'button';
      g.onclick = async () => {
        const itens = p.venda.itens.map((it, i) => ({ n: it.n, quantidade: Number(qtds[i].value) || 0 })).filter((x) => x.quantidade > 0);
        if(!sel.value){ msg.className = 'msg erro'; msg.textContent = 'Escolha a natureza de operação.'; return; }
        if(!itens.length){ msg.className = 'msg erro'; msg.textContent = 'Nenhum item com quantidade.'; return; }
        const lista = itens.map((x) => { const it = p.venda.itens.find((y) => y.n === x.n); return `• ${x.quantidade}× ${it.descricao}`; }).join('\n');
        if(!confirm(`GERAR a nota de devolução (entrada) no Bling ${p.conta_bling === '1' ? 'AMG' : 'Primor'}?\n\nPedido ${p.loja} ${p.pedido} · cliente ${p.venda.cliente || ''}\nReferente à NF-e ${p.venda.numero}\nNatureza: ${sel.options[sel.selectedIndex].text}\n\n${lista}\n\nA nota fica PENDENTE no Bling (não vai para a Sefaz agora).`)) return;
        g.disabled = true; msg.className = 'msg'; msg.textContent = 'Gerando no Bling…';
        try{
          const r = await post('/api/devolucao-nf/gerar', { canal: alvo.canal, pedido: alvo.pedido, chave: chave || undefined, natureza: sel.value, itens });
          msg.className = 'msg ok'; msg.textContent = `✓ Nota de devolução nº ${r.numero || '?'} gerada no Bling (pendente${r.valor != null ? ', ' + reais(r.valor) : ''}). Confira e emita.`;
          g.remove(); ac.insertBefore(botaoEmitir(p, msg), f);
        }catch(e){ msg.className = 'msg erro'; msg.textContent = 'Não gerou: ' + e.message; g.disabled = false; }
      };
      ac.append(g, f); corpo.append(msg, ac);
    }

    function botaoEmitir(p, msg){
      const b = mk('button', 'bt primario', 'Emitir nota de devolução'); b.type = 'button';
      b.onclick = async () => {
        if(!confirm(`EMITIR a nota de devolução do pedido ${p.loja} ${p.pedido}?\n\nO Bling envia para a Sefaz. Nota autorizada não volta atrás: só com cancelamento.`)) return;
        b.disabled = true; msg.className = 'msg'; msg.textContent = 'Enviando para a Sefaz pelo Bling… (até 30 s)';
        try{
          const r = await post('/api/devolucao-nf/emitir', { canal: alvo.canal, pedido: alvo.pedido });
          if(r.autorizada){ msg.className = 'msg ok'; msg.textContent = `✓ Nota de devolução nº ${r.numero || ''} ${r.situacao_nome.toLowerCase()}.`; b.remove(); }
          else if(r.rejeitada){ msg.className = 'msg erro'; msg.textContent = `A Sefaz rejeitou a nota ${r.numero || ''}: veja o motivo no Bling, corrija e emita de novo.`; b.disabled = false; }
          else { msg.className = 'msg'; msg.textContent = `Enviada. Situação no Bling: ${r.situacao_nome}. Abra de novo daqui a pouco.`; }
        }catch(e){ msg.className = 'msg erro'; msg.textContent = 'Não emitiu: ' + e.message; b.disabled = false; }
      };
      return b;
    }
    carregar(null);
  }

  window.botaoNotaDevolucao = function(alvo){
    const b = mk('button', 'nfdev-bt', 'Nota de devolução'); b.type = 'button';
    b.title = 'Gerar e emitir a nota fiscal de devolução (entrada) pelo Bling';
    b.onclick = () => abrir(alvo);
    return b;
  };
})();
