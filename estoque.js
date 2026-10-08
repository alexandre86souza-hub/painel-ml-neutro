'use strict';
// Estoque (tela public/estoque.html, módulo "estoque" dos usuários). Feito a partir da planilha do
// vendedor (Controle de Estoque: Cadastro Produtos, Fornecedores, Movimentações, Compras, Recebimentos,
// Estoque e Reposição) — as MESMAS fórmulas de reposição, agora com a baixa automática das vendas.
//
// - Produto = o número do catálogo (produtos_custo: 407 = DQ-407). Venda do SKU KIT-407.408 tira 1
//   DQ-407 e 1 BP-408 (custos.js#componentes), vezes a quantidade.
// - Saldo começa na 1ª CONTAGEM física (decisão do vendedor): até ela, o saldo é zero e a contagem
//   mostra o saldo da planilha só como referência. O histórico importado (historico=1) serve para a
//   média de saída, o custo médio e os relatórios; não entra no saldo.
// - Baixa automática a partir da 1ª contagem (`estoque_inicio`): ML, Shopee, Amazon, Leroy e Magalu,
//   pelas cópias locais das vendas. Venda do Full/FBA NÃO baixa (sai do armazém do marketplace): o
//   envio ao Full é uma saída manual ("Envio Full ML/Amazon"), como na planilha. Cancelou = volta.
//   Cada linha de venda tem uma `ref`; a baixa compara o que já lançou com o que deveria e lança só a
//   diferença — rodar de novo nunca duplica.
// - Devolução do ML volta ao estoque sozinha quando o produto CHEGA (status_devolucao delivered/closed) e só o
//   que está SEM defeito, pela marcação da tela Devoluções (devolucao_defeito; no kit, as peças marcadas ficam
//   de fora). Sem marcação = pendente até alguém marcar. Devolução de venda do Full volta ao armazém do ML:
//   não entra. Outras devoluções (Shopee, Amazon…): lançamento manual "Devolução", só do que voltou bom.
// - Reposição (planilha): média = saídas de 6 meses / 6; mínimo = ⌈média × prazo do fornecedor⌉;
//   máximo = ⌈média × prazo + mínimo⌉; sugestão = ⌈média × prazo − saldo − pedidos em aberto⌉;
//   "Repor agora" saldo ≤ máximo, "Próximo de repor" ≤ 1,25 × máximo. Só produto Ativo. Fornecedor
//   descontinuado (na planilha: prazo 0) = "Não repor": o produto segue vendendo o que sobrou, sem sugestão.
//   Descontinuado ou "Não repor" COM saldo = "Vender o restante" (vender o que sobrou e não comprar mais).
// Nada do estoque no MCP (tem vendas da Amazon/Leroy/Magalu; test-estoque.js reprova).
const C = require('./custos.js');
const X = require('./xlsx.js');

const r2 = (v) => Math.round(v * 100) / 100;
const erro = (m, status = 400) => Object.assign(new Error(m), { status });
const diaLocal = (iso) => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10);
const meioDia = (dia) => `${dia}T15:00:00.000Z`;   // 12h de Brasília: o dia não muda com o fuso
const TIPOS_MANUAIS = { entrada: 1, saida: -1, devolucao: 1 };
const TIPO_NOME = { entrada: 'Entrada', compra: 'Recebimento de compra', saida: 'Saída', venda: 'Venda', cancelamento: 'Venda cancelada',
  devolucao: 'Devolução', ajuste: 'Ajuste de contagem' };

// ---------- funções puras (testadas) ----------

// Código digitado -> números dos produtos. "DQ-407" (do catálogo), "407" ou um kit "KIT-407.408".
function numerosDoCodigo(codigo, porSku) {
  const c = String(codigo || '').trim();
  if (!c) return [];
  const exato = porSku.get(c.toUpperCase());
  if (exato != null) return [exato];
  if (/^\d+$/.test(c)) return [Number(c)];
  return C.componentes(c);
}
// [numero, numero…] -> Map(numero -> quantas vezes)
const contar = (nums) => nums.reduce((m, n) => m.set(n, (m.get(n) || 0) + 1), new Map());

// Reposição de UM produto (fórmulas da aba Estoque da planilha).
function reposicao({ ativo, saldo, saidas6m, prazo, abertos = 0, repor = true }) {
  const media = saidas6m / 6;
  const dias = media > 0 ? Math.round(saldo / media * 30) : null;
  if (!ativo || !repor) return { media: r2(media), minimo: 0, maximo: 0, sugestao: 0, dias,
    status: saldo > 0 ? 'Vender o restante' : ativo ? 'Não repor' : 'Descontinuado' };
  const minimo = ativo ? Math.ceil(media * prazo - 1e-9) : 0;
  const maximo = Math.ceil(media * prazo + minimo - 1e-9);
  const sugestao = ativo ? Math.max(0, Math.ceil(media * prazo - saldo - abertos - 1e-9)) : 0;
  const status = !ativo ? 'Descontinuado' : saldo <= maximo ? 'Repor agora' : saldo <= maximo * 1.25 ? 'Próximo de repor' : 'Regular';
  return { media: r2(media), minimo, maximo, sugestao, status, dias: media > 0 ? Math.round(saldo / media * 30) : null };
}

// Planilha -> dados para importar. Aceita "Saida" sem acento (a planilha deixava esses de fora do
// saldo) e avisa de datas no futuro.
function importacaoDe(p, hoje = new Date().toISOString().slice(0, 10)) {
  const aba = (n) => { const l = p.aba(n); if (!l) throw erro(`A planilha não tem a aba "${n}".`); return l; };
  const txt = (v) => (v == null ? null : String(v).trim() || null);
  const num = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.')) || 0);
  const produtos = [];
  for (const l of aba('Cadastro Produtos').slice(5)) {
    if (!l || typeof l[0] !== 'number') continue;
    produtos.push({ numero: l[0], sku: txt(l[1]), custo: num(l[2]) || null, nome: txt(l[3]), classificacao: txt(l[5]), situacao: txt(l[6]),
      ref_compra: txt(l[7]), fornecedor: txt(l[8]) });
  }
  const fornecedores = [];
  for (const l of aba('Fornecedores').slice(5)) {
    if (!l || !txt(l[0])) continue;
    fornecedores.push({ nome: txt(l[0]), representante: txt(l[1]), telefone: txt(l[2]), endereco: txt(l[3]), prazo_meses: num(l[4]) });
  }
  // Fornecedor escrito de outro jeito no cadastro ("Bruno" e "BRUNO"): vale o nome da lista de fornecedores.
  const nomeForn = new Map(fornecedores.map((f) => [f.nome.toLowerCase(), f.nome]));
  for (const p of produtos) if (p.fornecedor) p.fornecedor = nomeForn.get(p.fornecedor.toLowerCase()) || p.fornecedor;
  for (const p of produtos) {
    if (p.fornecedor && !nomeForn.has(p.fornecedor.toLowerCase())) {
      nomeForn.set(p.fornecedor.toLowerCase(), p.fornecedor);
      fornecedores.push({ nome: p.fornecedor, representante: null, telefone: null, endereco: null, prazo_meses: 1 });   // prazo padrão da planilha
    }
  }
  for (const f of fornecedores) {
    // prazo 0 na planilha = fornecedor descontinuado (não repor)
    f.situacao = f.prazo_meses > 0 && produtos.some((p) => p.situacao === 'Ativo' && p.fornecedor?.toLowerCase() === f.nome.toLowerCase()) ? 'Ativo' : 'Descontinuado';
  }
  const CANAIS = /^(mercado livre|shopee|amazon|leroy( merlin)?|magalu)$/i;
  const movimentos = [];
  const avisos = { saida_sem_acento: 0, saida_sem_acento_qtd: 0, datas_futuras: 0, sem_produto: 0 };
  for (const l of aba('Movimentações').slice(5)) {
    if (!l || typeof l[0] !== 'number' || typeof l[2] !== 'number') continue;
    const q = num(l[4]);
    if (!q) continue;
    const t = String(l[1] || '').trim().toLowerCase();
    const entra = t === 'entrada';
    if (!entra && !/^sa[ií]da$/.test(t)) continue;
    if (t === 'saida') { avisos.saida_sem_acento++; avisos.saida_sem_acento_qtd += q; }
    const dia = X.dataDoExcel(l[0]);
    if (dia > hoje) avisos.datas_futuras++;
    const origem = /^leroy$/i.test(txt(l[6]) || '') ? 'Leroy Merlin' : txt(l[6]);   // o mesmo nome da baixa automática
    const tipo = /contagem/i.test(origem || '') ? 'ajuste' : entra ? (/devolu/i.test(origem || '') ? 'devolucao' : 'entrada')
      : CANAIS.test(origem || '') ? 'venda' : 'saida';
    movimentos.push({ data: meioDia(dia), tipo, numero: l[2], qtd: entra ? q : -q, valor_unit: num(l[5]) || null, origem });
  }
  const receb = new Map();
  for (const l of (p.aba('Recebimentos') || []).slice(5)) {
    if (!l || !txt(l[0]) || typeof l[2] !== 'number') continue;
    receb.set(`${txt(l[0])}|${l[2]}`, { confirmado: /^sim$/i.test(txt(l[9]) || ''), qtd: num(l[7]), valor: num(l[8]) || null, data: X.dataDoExcel(l[1]) });
  }
  const compras = [];
  for (const l of (p.aba('Compras') || []).slice(5)) {
    if (!l || !txt(l[0]) || typeof l[2] !== 'number' || typeof l[1] !== 'number') continue;
    const r = receb.get(`${txt(l[0])}|${l[2]}`);
    compras.push({ pedido: txt(l[0]), data: X.dataDoExcel(l[1]), numero: l[2], qtd: num(l[3]), fornecedor: txt(l[7]),
      previsao: X.dataDoExcel(l[9]), status: r?.confirmado ? 'recebido' : 'aberto', recebido_qtd: r?.confirmado ? r.qtd : 0,
      valor_pago: r?.confirmado ? r.valor : null, recebido_em: r?.confirmado ? r.data : null, da_planilha: true });
  }
  return { produtos, fornecedores, movimentos, compras, avisos };
}

// Relatório: movimentos -> linhas por período e grupo. periodo: dia|semana|mes|ano; por: total|loja|canal|produto.
const periodoDe = (dia, periodo) => {
  if (periodo === 'ano') return dia.slice(0, 4);
  if (periodo === 'mes') return dia.slice(0, 7);
  if (periodo === 'semana') {   // segunda-feira da semana
    const d = new Date(dia + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return dia;
};
const canalDe = (origem) => String(origem || 'Sem origem').split(' · ')[0];
function relatorio(movs, { periodo = 'mes', por = 'total', nomes = new Map() } = {}) {
  const linhas = new Map();
  for (const m of movs) {
    const p = periodoDe(diaLocal(m.data), periodo);
    const g = por === 'loja' ? (m.origem || 'Sem origem') : por === 'canal' ? canalDe(m.origem) : por === 'produto' ? (nomes.get(m.numero) || String(m.numero)) : 'Total';
    const k = `${p}|${g}`;
    const x = linhas.get(k) || { periodo: p, grupo: g, entradas: 0, saidas: 0, ajustes: 0, valor_entradas: 0, valor_saidas: 0 };
    const v = (m.valor_unit || 0) * Math.abs(m.qtd);
    if (m.tipo === 'ajuste') x.ajustes += m.qtd;
    else if (['venda', 'saida', 'cancelamento'].includes(m.tipo)) { x.saidas -= m.qtd; x.valor_saidas += m.qtd < 0 ? v : -v; }
    else { x.entradas += m.qtd; x.valor_entradas += v; }
    linhas.set(k, x);
  }
  return [...linhas.values()].map((x) => ({ ...x, valor_entradas: r2(x.valor_entradas), valor_saidas: r2(x.valor_saidas) }))
    .sort((a, b) => b.periodo.localeCompare(a.periodo) || b.saidas - a.saidas);
}

// O que a baixa automática tem de lançar: linhas de venda -> por ref|numero o saldo que deveria ter
// (−qtd × vezes no kit; 0 se cancelada ou do Full) contra o que já lançou. Função pura: testada.
function diferencas(linhas, jaLancado, porSku) {
  const desejado = new Map(), pendentes = [];
  for (const l of linhas) {
    const todos = numerosDoCodigo(l.sku, porSku);
    if (l.valida && (!todos.length || todos.some((n) => !porSku.numeros.has(n)))) {
      pendentes.push({ ref: l.ref, loja: l.origem, sku: l.sku || null, data: l.data, qtd: l.qtd, motivo: 'sku' });
      continue;
    }
    if (l.pendente) { pendentes.push({ ref: l.ref, loja: l.origem, sku: l.sku || null, data: l.data, qtd: l.qtd, motivo: l.pendente }); continue; }
    const nums = l.sem ? todos.filter((_, i) => !l.sem.includes(i)) : todos;
    const sinal = l.sinal || -1;
    for (const n of contar(todos).keys()) {
      const fica = nums.filter((x) => x === n).length;   // quantas desse produto valem (kit com peça com defeito)
      const k = `${l.ref}|${n}`;
      desejado.set(k, { ...l, numero: n, alvo: (desejado.get(k)?.alvo || 0) + (l.valida ? sinal * l.qtd * fica : 0) });
    }
  }
  const lancar = [];
  for (const [k, d] of desejado) {
    const dif = d.alvo - (jaLancado.get(k) || 0);
    if (dif) lancar.push({ ref: d.ref, numero: d.numero, qtd: dif, tipo: d.tipo || (dif < 0 ? 'venda' : 'cancelamento'), origem: d.origem, data: d.data });
  }
  return { lancar, pendentes };
}

// ---------- módulo ----------
function criar({ D, sincronizarMl, atualizarDevolucoes, shopeeVendas, amazon, leroy, magalu, quem = () => null }) {
  const inicio = () => D.configLer('estoque_inicio');
  function catalogo() {
    const extra = new Map(D.estoqueProdutos().map((p) => [p.numero, p]));
    const lista = D.catalogoListar().map((p) => ({ numero: p.numero, sku: p.sku, nome: p.nome, custo: p.custo,
      situacao: extra.get(p.numero)?.situacao || p.situacao || 'Ativo', classificacao: extra.get(p.numero)?.classificacao || null,
      ref_compra: extra.get(p.numero)?.ref_compra || null, fornecedor: extra.get(p.numero)?.fornecedor || p.fornecedor || null }));
    const porNumero = new Map(lista.map((p) => [p.numero, p]));
    const porSku = new Map(lista.filter((p) => p.sku).map((p) => [p.sku.toUpperCase(), p.numero]));
    porSku.numeros = new Set(porNumero.keys());
    return { lista, porNumero, porSku };
  }
  // itens [{codigo, qtd}] -> [{numero, qtd}] (kit vira os produtos dele)
  function expandir(itens, cat) {
    const out = new Map();
    for (const it of Array.isArray(itens) ? itens : []) {
      const q = Math.round(Number(it.qtd));
      if (!Number.isFinite(q) || q <= 0 || q > 100000) throw erro(`Quantidade inválida para ${it.codigo}.`);
      const nums = numerosDoCodigo(it.codigo, cat.porSku);
      if (!nums.length) throw erro(`Não reconheci o produto "${it.codigo}". Use o SKU (DQ-407), o número (407) ou o SKU do kit (KIT-407.408).`);
      const fora = nums.filter((n) => !cat.porNumero.has(n));
      if (fora.length) throw erro(`O produto ${fora.join(', ')} não está na tabela de produtos.`);
      const valor = nums.length === 1 && Number(it.valor_unit) > 0 ? Number(it.valor_unit) : null;   // valor só de produto avulso
      for (const [n, v] of contar(nums)) {
        const x = out.get(n) || { numero: n, qtd: 0, valor_unit: null };
        x.qtd += q * v; if (valor != null) x.valor_unit = valor;
        out.set(n, x);
      }
    }
    if (!out.size) throw erro('Informe ao menos um produto.');
    return [...out.values()];
  }
  const dataOuAgora = (dia) => {
    if (!dia) return new Date().toISOString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw erro('Data inválida.');
    return dia === diaLocal(new Date().toISOString()) ? new Date().toISOString() : meioDia(dia);
  };

  // Saída de uma venda feita fora dos marketplaces (comanda manual) e o estorno dela.
  function lancarVendaManual(ref, itens, origem, obs) {
    const cat = catalogo();
    const linhas = expandir(itens, cat);
    D.estoqueMovGravar(linhas.map((l) => ({ data: new Date().toISOString(), tipo: 'venda', numero: l.numero, qtd: -l.qtd,
      valor_unit: cat.porNumero.get(l.numero)?.custo ?? null, origem, ref, quem: quem(), obs })));
    return linhas;
  }
  function estornarRef(ref, origem) {
    const soma = D.estoqueSomaPorRef(ref);
    const cat = catalogo();
    const volta = [...soma].filter(([k, s]) => k.startsWith(ref + '|') && s).map(([k, s]) => ({ numero: Number(k.split('|').pop()), qtd: -s }));
    if (volta.length) D.estoqueMovGravar(volta.map((v) => ({ data: new Date().toISOString(), tipo: 'cancelamento', numero: v.numero, qtd: v.qtd,
      valor_unit: cat.porNumero.get(v.numero)?.custo ?? null, origem, ref, quem: quem() })));
  }

  // ---- baixa automática das vendas
  function linhasDeVenda(desde) {
    const db = D.db, out = [];
    const nomeConta = new Map(D.contasListar().map((c) => [c.ml_user_id, c.nickname]));
    for (const v of db.prepare('SELECT order_id, item_id, variacao, ml_user_id, data, status, quantidade, sku, origem FROM vendas WHERE data >= ?').all(desde)) {
      const full = !!v.origem && !/^BRP\d+$/.test(v.origem);
      out.push({ ref: `venda:ml:${v.order_id}:${v.item_id}:${v.variacao}`, sku: v.sku, qtd: v.quantidade, data: v.data,
        valida: v.status !== 'cancelled' && !full, origem: `Mercado Livre · ${nomeConta.get(v.ml_user_id) || v.ml_user_id}` });
    }
    const lojas = new Map(D.shopeeLojasListar().map((l) => [l.shop_id, l.nome || `Loja ${l.shop_id}`]));
    for (const i of db.prepare(`SELECT p.order_sn, p.shop_id, p.data, p.status, i.linha, i.sku, i.quantidade FROM shopee_pedidos p
        JOIN shopee_itens i ON i.order_sn = p.order_sn WHERE p.data >= ?`).all(desde)) {
      out.push({ ref: `venda:shopee:${i.order_sn}:${i.linha}`, sku: i.sku, qtd: i.quantidade, data: i.data,
        valida: !['CANCELLED', 'IN_CANCEL', 'UNPAID'].includes(i.status), origem: `Shopee · ${lojas.get(i.shop_id) || i.shop_id}` });
    }
    const trAmz = D.skuTrocas('amazon'), trLm = D.skuTrocas('leroy'), trMg = D.skuTrocas('magalu');
    for (const i of db.prepare(`SELECT p.pedido, p.data, p.status, p.canal, i.item_id, i.sku, i.quantidade FROM amazon_pedidos p
        JOIN amazon_itens i ON i.pedido = p.pedido WHERE p.data >= ?`).all(desde)) {
      out.push({ ref: `venda:amazon:${i.pedido}:${i.item_id}`, sku: C.skuNaData(trAmz, i.sku, i.data), qtd: i.quantidade, data: i.data,
        valida: i.status !== 'Canceled' && i.canal !== 'FBA', origem: 'Amazon' });
    }
    for (const p of db.prepare('SELECT order_id, data, status, linhas FROM leroy_pedidos WHERE data >= ?').all(desde)) {
      for (const l of JSON.parse(p.linhas || '[]')) {
        out.push({ ref: `venda:leroy:${p.order_id}:${l.id}`, sku: C.skuNaData(trLm, l.sku, p.data), qtd: l.quantidade, data: p.data,
          valida: !/^(CANCELED|REFUSED)$/.test(p.status || '') && !/^(CANCELED|REFUSED)$/.test(l.estado || ''), origem: 'Leroy Merlin' });
      }
    }
    const vinc = D.skuVinculos('magalu');
    for (const p of db.prepare('SELECT code, data, status, itens FROM magalu_pedidos WHERE data >= ?').all(desde)) {
      JSON.parse(p.itens || '[]').forEach((i, k) => out.push({ ref: `venda:magalu:${p.code}:${k}`, sku: C.skuNaData(trMg, (i.sku && vinc.get(i.sku)) || i.sku, p.data),
        qtd: i.quantidade, data: p.data, valida: !/cancel/i.test(p.status || ''), origem: 'Magalu' }));
    }
    return out.filter((l) => l.qtd > 0);
  }
  // Devoluções do ML que chegaram ao vendedor (as que já tinham chegado na 1ª contagem ficam de fora:
  // já estavam na prateleira contada).
  function linhasDeDevolucao(desde) {
    const antes = new Set(JSON.parse(D.configLer('estoque_devol_antes') || '[]'));
    const nomeConta = new Map(D.contasListar().map((c) => [c.ml_user_id, c.nickname]));
    const de = new Date(Date.parse(desde) - 90 * 864e5).toISOString();
    return D.db.prepare(`SELECT d.claim_id, d.ml_user_id, d.quantidade, d.status_devolucao, d.atualizada_em, v.sku, v.origem,
        f.defeito, f.produtos FROM devolucoes d
        LEFT JOIN vendas v ON v.order_id = d.order_id AND v.item_id = d.item_id
        LEFT JOIN devolucao_defeito f ON f.claim_id = d.claim_id
        WHERE d.criada_em >= ? AND d.status_devolucao IN ('delivered', 'closed')`).all(de)
      .filter((d) => !antes.has(d.claim_id) && !(d.origem && !/^BRP\d+$/.test(d.origem)))   // Full: volta ao armazém do ML
      .map((d) => {
        let sem = null, pendente = null;
        if (d.defeito == null) pendente = 'defeito';                      // ninguém conferiu ainda
        else if (d.defeito === 1) { try { sem = JSON.parse(d.produtos || 'null'); } catch { sem = null; } if (!Array.isArray(sem)) sem = [...Array(50).keys()]; }
        return { ref: `devolucao:ml:${d.claim_id}`, sku: d.sku, qtd: Math.round(d.quantidade || 1), data: d.atualizada_em || new Date().toISOString(),
          valida: true, sinal: 1, sem, pendente, tipo: 'devolucao', origem: `Mercado Livre · ${nomeConta.get(d.ml_user_id) || d.ml_user_id}` };
      });
  }
  let pendentes = [], ultimaBaixa = null, baixando = null, errosBaixa = [];
  function baixar({ sincronizar = true } = {}) {
    if (baixando) return baixando;
    baixando = (async () => {
      const desde = inicio();
      if (!desde) return { lancados: 0 };
      const erros = [];
      if (sincronizar) {
        const passo = async (nome, fn) => { try { await fn(); } catch (e) { erros.push(`${nome}: ${e.message}`); } };
        await Promise.all([
          ...D.contasListar().map((c) => passo(`Mercado Livre ${c.nickname}`, () => sincronizarMl(c, 7))),
          ...(atualizarDevolucoes ? D.contasListar().map((c) => passo(`Devoluções ${c.nickname}`, () => atualizarDevolucoes(c, new Date(Date.now() - 60 * 864e5)))) : []),
          ...D.shopeeLojasListar().map((l) => passo(`Shopee ${l.nome || l.shop_id}`, () => shopeeVendas.sincronizar(l.shop_id))),
          D.configLer('amazon_refresh_token') ? passo('Amazon', async () => { await amazon.sincronizarPedidos(); amazon.lerItens().catch(() => null); }) : null,
          leroy?.config()?.api_key ? passo('Leroy', () => leroy.sincronizar()) : null,
          magalu?.config()?.refresh ? passo('Magalu', () => magalu.sincronizar()) : null,
        ].filter(Boolean));
      }
      const cat = catalogo();
      const v = diferencas(linhasDeVenda(desde), D.estoqueSomaPorRef('venda:'), cat.porSku);
      const dv = diferencas(linhasDeDevolucao(desde), D.estoqueSomaPorRef('devolucao:'), cat.porSku);
      const lancar = [...v.lancar, ...dv.lancar], p = [...v.pendentes, ...dv.pendentes];
      if (lancar.length) {
        D.estoqueMovGravar(lancar.map((m) => ({ data: m.tipo === 'venda' ? m.data : new Date().toISOString(), tipo: m.tipo, numero: m.numero, qtd: m.qtd,
          valor_unit: cat.porNumero.get(m.numero)?.custo ?? null, origem: m.origem, ref: m.ref, quem: 'automático',
          obs: m.tipo === 'devolucao' ? 'Devolução sem defeito (tela Devoluções)' : null })));
      }
      pendentes = p; ultimaBaixa = new Date().toISOString(); errosBaixa = erros;
      return { lancados: lancar.length };
    })().finally(() => { baixando = null; });
    return baixando;
  }
  const timer = setInterval(() => { if (inicio()) baixar().catch(() => null); }, 10 * 60e3);
  timer.unref?.();

  // ---- visão geral (aba Estoque)
  function visao() {
    const cat = catalogo();
    const saldos = D.estoqueSaldos();
    const seis = new Date(); seis.setMonth(seis.getMonth() - 6);
    const res = new Map(D.estoqueResumoMov(seis.toISOString()).map((r) => [r.numero, r]));
    const forns = D.fornecedoresListar();
    const prazos = new Map(forns.map((f) => [String(f.nome).toLowerCase(), f.prazo_meses]));
    const parados = new Set(forns.filter((f) => f.situacao === 'Descontinuado').map((f) => String(f.nome).toLowerCase()));
    const abertos = new Map();
    for (const c of D.comprasListar()) if (c.status === 'aberto' || c.status === 'parcial') abertos.set(c.numero, (abertos.get(c.numero) || 0) + Math.max(0, c.qtd - c.recebido_qtd));
    const produtos = cat.lista.map((p) => {
      const r = res.get(p.numero) || {};
      const saldo = saldos.get(p.numero) || 0;
      const prazo = prazos.get(String(p.fornecedor || '').toLowerCase()) ?? 1;
      const rep = reposicao({ ativo: p.situacao === 'Ativo', saldo, saidas6m: r.saidas || 0, prazo, abertos: abertos.get(p.numero) || 0,
        repor: !parados.has(String(p.fornecedor || '').toLowerCase()) });
      const custoMedio = r.ent_qtd ? r2(r.ent_valor / r.ent_qtd) : p.custo;
      return { ...p, saldo, saidas6m: r.saidas || 0, prazo, em_pedido: abertos.get(p.numero) || 0, ...rep, custo_medio: custoMedio,
        valor: custoMedio != null ? r2(saldo * custoMedio) : null, ultima_saida: r.ultima_saida || null };
    });
    const ativos = produtos.filter((p) => p.situacao === 'Ativo');
    return { inicio: inicio(), ultima_baixa: ultimaBaixa, baixando: !!baixando, erros: errosBaixa, pendentes: pendentes.slice(0, 300),
      total_pendentes: pendentes.length, importado_em: D.configLer('estoque_importado_em'),
      resumo: { ativos: ativos.length, repor: ativos.filter((p) => p.status === 'Repor agora').length,
        proximo: ativos.filter((p) => p.status === 'Próximo de repor').length, nao_repor: ativos.filter((p) => p.status === 'Não repor').length,
        vender_restante: produtos.filter((p) => p.status === 'Vender o restante').length,
        vender_restante_pecas: produtos.filter((p) => p.status === 'Vender o restante').reduce((s, p) => s + p.saldo, 0),
        vender_restante_valor: r2(produtos.filter((p) => p.status === 'Vender o restante').reduce((s, p) => s + (p.valor || 0), 0)),
        valor: r2(produtos.reduce((s, p) => s + (p.saldo > 0 && p.valor ? p.valor : 0), 0)), unidades: produtos.reduce((s, p) => s + Math.max(0, p.saldo), 0),
        negativos: produtos.filter((p) => p.saldo < 0).length },
      produtos };
  }

  const proximoPedido = () => {
    const ids = D.comprasListar().map((c) => c.pedido);
    const m = ids.map((i) => /^(.*?)(\d+)$/.exec(i)).filter(Boolean).sort((a, b) => Number(b[2]) - Number(a[2]))[0];
    return m ? `${m[1]}${String(Number(m[2]) + 1).padStart(m[2].length, '0')}` : 'PC-001';
  };
  const addMeses = (dia, meses) => { const d = new Date(dia + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + Math.round(meses || 0)); return d.toISOString().slice(0, 10); };

  const rotas = {
    'GET /api/estoque': async (url) => {
      if (inicio()) {
        const espera = baixar({ sincronizar: url.searchParams.get('recarregar') === '1' || !ultimaBaixa || Date.now() - Date.parse(ultimaBaixa) > 5 * 60e3 });
        await Promise.race([espera, new Promise((ok) => setTimeout(ok, 8000))]).catch(() => null);
      }
      return visao();
    },
    'GET /api/estoque/movimentos': async (url) => {
      const q = url.searchParams;
      const cat = catalogo();
      const n = q.get('produto') ? numerosDoCodigo(q.get('produto'), cat.porSku)[0] : null;
      if (q.get('produto') && n == null) throw erro('Produto não encontrado.');
      return { movimentos: D.estoqueMovListar({ numero: n, de: q.get('de') ? `${q.get('de')}T03:00:00.000Z` : null,
        ate: q.get('ate') ? new Date(Date.parse(`${q.get('ate')}T03:00:00.000Z`) + 864e5 - 1).toISOString() : null, tipo: q.get('tipo') || null, origem: q.get('origem') || null,
        historico: q.get('historico') === '1' ? null : false, limite: 1000 })
        .map((m) => ({ ...m, sku: cat.porNumero.get(m.numero)?.sku || null, nome: cat.porNumero.get(m.numero)?.nome || null,
          tipo_nome: TIPO_NOME[m.tipo] || m.tipo, pode_desfazer: !m.historico && !m.desfeito && ['entrada', 'saida', 'devolucao'].includes(m.tipo) })) };
    },
    // Relatório de entradas e saídas: dia, semana, mês ou ano; total, por loja, canal ou produto.
    'GET /api/estoque/relatorio': async (url) => {
      const q = url.searchParams;
      const ate = q.get('ate') || diaLocal(new Date().toISOString());
      const de = q.get('de') || `${ate.slice(0, 4)}-01-01`;
      if (![de, ate].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) throw erro('Datas inválidas.');
      const periodo = ['dia', 'semana', 'mes', 'ano'].includes(q.get('periodo')) ? q.get('periodo') : 'mes';
      const por = ['total', 'loja', 'canal', 'produto'].includes(q.get('por')) ? q.get('por') : 'total';
      const cat = catalogo();
      let movs = D.estoqueRelatorio(`${de}T03:00:00.000Z`, new Date(Date.parse(`${ate}T03:00:00.000Z`) + 864e5 - 1).toISOString());
      const prod = q.get('produto') ? numerosDoCodigo(q.get('produto'), cat.porSku)[0] : null;
      if (prod != null) movs = movs.filter((m) => m.numero === prod);
      if (q.get('loja')) movs = movs.filter((m) => (m.origem || 'Sem origem') === q.get('loja') || canalDe(m.origem) === q.get('loja'));
      const nomes = new Map(cat.lista.map((p) => [p.numero, `${p.sku || p.numero} · ${p.nome || ''}`]));
      const linhas = relatorio(movs, { periodo, por, nomes });
      const tot = linhas.reduce((t, l) => ({ entradas: t.entradas + l.entradas, saidas: t.saidas + l.saidas, ajustes: t.ajustes + l.ajustes,
        valor_entradas: r2(t.valor_entradas + l.valor_entradas), valor_saidas: r2(t.valor_saidas + l.valor_saidas) }),
      { entradas: 0, saidas: 0, ajustes: 0, valor_entradas: 0, valor_saidas: 0 });
      const lojas = [...new Set(D.estoqueRelatorio('2000', '9999').map((m) => m.origem || 'Sem origem'))].sort();
      return { de, ate, periodo, por, linhas: linhas.slice(0, 5000), total: tot, lojas, canais: [...new Set(lojas.map(canalDe))].sort() };
    },
    // Lançamento manual: entrada (fornecedor), saída (Josi, troca, envio ao Full…) ou devolução.
    'POST /api/estoque/lancar': async (_u, b) => {
      const sinal = TIPOS_MANUAIS[b?.tipo];
      if (!sinal) throw erro('Tipo inválido.');
      const origem = String(b?.origem || '').trim().slice(0, 60);
      if (!origem) throw erro(b.tipo === 'entrada' ? 'Informe o fornecedor (ou de onde veio).' : 'Informe o destino/loja.');
      const cat = catalogo();
      const linhas = expandir(b.itens, cat);
      const data = dataOuAgora(b.data);
      const obs = String(b?.obs || '').trim().slice(0, 200) || null;
      const ids = D.estoqueMovGravar(linhas.map((l) => ({ data, tipo: b.tipo, numero: l.numero, qtd: sinal * l.qtd,
        valor_unit: l.valor_unit ?? cat.porNumero.get(l.numero)?.custo ?? null,
        origem, ref: `manual:${b.tipo}`, quem: quem(), obs })));
      return { lancados: ids.length };
    },
    'POST /api/estoque/desfazer': async (_u, b) => {
      const m = D.estoqueMovObter(Number(b?.id));
      if (!m || m.historico || m.desfeito || !['entrada', 'saida', 'devolucao'].includes(m.tipo)) throw erro('Esse lançamento não pode ser desfeito aqui.');
      return { desfeitos: D.estoqueMovDesfeito(m) };
    },
    // Contagem física: rascunho por produto e, ao finalizar, o ajuste (contado − saldo). A 1ª liga a baixa automática.
    'GET /api/estoque/contagem': async () => {
      const cat = catalogo();
      const saldos = D.estoqueSaldos();
      const planilha = new Map(D.db.prepare('SELECT numero, SUM(qtd) s FROM estoque_mov WHERE historico=1 GROUP BY numero').all().map((r) => [r.numero, r.s]));
      const rasc = new Map(D.contagemListar().map((c) => [c.numero, c]));
      return { inicio: inicio(), produtos: cat.lista.map((p) => ({ numero: p.numero, sku: p.sku, nome: p.nome, situacao: p.situacao,
        fornecedor: p.fornecedor, saldo: saldos.get(p.numero) || 0, planilha: planilha.get(p.numero) ?? null,
        contado: rasc.get(p.numero)?.contado ?? null, contado_por: rasc.get(p.numero)?.quem || null })) };
    },
    'PUT /api/estoque/contagem': async (_u, b) => {
      const n = Number(b?.numero);
      if (!catalogo().porNumero.has(n)) throw erro('Produto não encontrado.');
      const c = b?.contado === null || b?.contado === '' ? null : Math.round(Number(b?.contado));
      if (c != null && (!Number.isFinite(c) || c < 0 || c > 1e6)) throw erro('Quantidade contada inválida.');
      D.contagemGravar(n, c, quem());
      return { ok: true };
    },
    'POST /api/estoque/contagem/finalizar': async (_u, b) => {
      const rasc = D.contagemListar();
      const escolha = Array.isArray(b?.numeros) && b.numeros.length ? new Set(b.numeros.map(Number)) : null;
      const lista = rasc.filter((c) => !escolha || escolha.has(c.numero));
      if (!lista.length) throw erro('Nenhum produto contado para finalizar.');
      if (inicio()) await baixar({ sincronizar: false }).catch(() => null);   // saldo em dia antes do ajuste
      const saldos = D.estoqueSaldos();
      const cat = catalogo();
      const agora = new Date().toISOString();
      const ajustes = lista.map((c) => ({ numero: c.numero, qtd: c.contado - (saldos.get(c.numero) || 0) })).filter((a) => a.qtd);
      D.estoqueMovGravar(ajustes.map((a) => ({ data: agora, tipo: 'ajuste', numero: a.numero, qtd: a.qtd, valor_unit: cat.porNumero.get(a.numero)?.custo ?? null,
        origem: 'Contagem de estoque', ref: 'contagem', quem: quem() })));
      D.contagemApagar(lista.map((c) => c.numero));
      const primeira = !inicio();
      if (primeira) {
        D.configGravar('estoque_inicio', agora);
        D.configGravar('estoque_devol_antes', JSON.stringify(D.db.prepare("SELECT claim_id FROM devolucoes WHERE status_devolucao IN ('delivered', 'closed')").all().map((x) => x.claim_id)));
      }
      return { produtos: lista.length, ajustados: ajustes.length, baixa_ligada_em: primeira ? agora : null };
    },
    'PUT /api/estoque/produto': async (_u, b) => {
      const n = Number(b?.numero);
      if (!catalogo().porNumero.has(n)) throw erro('Produto não encontrado.');
      const t = (v, max = 80) => (v == null ? null : String(v).trim().slice(0, max) || null);
      const situacao = ['Ativo', 'Descontinuado', 'Amostra'].includes(b?.situacao) ? b.situacao : 'Ativo';
      D.estoqueProdutoGravar(n, { situacao, classificacao: t(b.classificacao), ref_compra: t(b.ref_compra), fornecedor: t(b.fornecedor) });
      return { ok: true };
    },
    // Fornecedores com quantos produtos ativos/total cada um tem no cadastro.
    'GET /api/estoque/fornecedores': async () => {
      const cat = catalogo().lista;
      return { fornecedores: D.fornecedoresListar().map((f) => {
        const deles = cat.filter((p) => String(p.fornecedor || '').toLowerCase() === f.nome.toLowerCase());
        return { ...f, situacao: f.situacao || 'Ativo', produtos: deles.length, produtos_ativos: deles.filter((p) => p.situacao === 'Ativo').length };
      }) };
    },
    'PUT /api/estoque/fornecedores': async (_u, b) => {
      const nome = String(b?.nome || '').trim().slice(0, 60);
      if (!nome) throw erro('Informe o nome do fornecedor.');
      const prazo = Number(b?.prazo_meses);
      D.fornecedorGravar({ nome, representante: String(b.representante || '').trim().slice(0, 60) || null, telefone: String(b.telefone || '').trim().slice(0, 40) || null,
        endereco: String(b.endereco || '').trim().slice(0, 160) || null, prazo_meses: Number.isFinite(prazo) && prazo >= 0 && prazo <= 36 ? prazo : 1,
        situacao: b.situacao === 'Descontinuado' ? 'Descontinuado' : 'Ativo' });
      return { ok: true };
    },
    'POST /api/estoque/fornecedores/remover': async (_u, b) => { D.fornecedorRemover(String(b?.nome || '')); return { ok: true }; },
    // Pedidos de compra ao fornecedor (aba Compras da planilha) e o recebimento, que vira entrada.
    'GET /api/estoque/compras': async () => {
      const cat = catalogo();
      return { proximo: proximoPedido(), compras: D.comprasListar().map((c) => ({ ...c, sku: cat.porNumero.get(c.numero)?.sku || null,
        nome: cat.porNumero.get(c.numero)?.nome || null, ref_compra: cat.porNumero.get(c.numero)?.ref_compra || null })) };
    },
    'POST /api/estoque/compras': async (_u, b) => {
      const fornecedor = String(b?.fornecedor || '').trim().slice(0, 60);
      if (!fornecedor) throw erro('Informe o fornecedor.');
      const data = /^\d{4}-\d{2}-\d{2}$/.test(b?.data || '') ? b.data : diaLocal(new Date().toISOString());
      const pedido = String(b?.pedido || '').trim().slice(0, 30) || proximoPedido();
      if (D.comprasListar().some((c) => c.pedido === pedido)) throw erro(`Já existe o pedido ${pedido}.`);
      const f = D.fornecedoresListar().find((x) => x.nome.toLowerCase() === fornecedor.toLowerCase());
      const previsao = /^\d{4}-\d{2}-\d{2}$/.test(b?.previsao || '') ? b.previsao : addMeses(data, f?.prazo_meses ?? 1);
      const linhas = expandir(b.itens, catalogo());
      D.comprasCriar(linhas.map((l) => ({ pedido, data, fornecedor, numero: l.numero, qtd: l.qtd, previsao, obs: String(b.obs || '').slice(0, 200) || null })));
      return { pedido, itens: linhas.length };
    },
    'POST /api/estoque/compras/receber': async (_u, b) => {
      const c = D.compraObter(Number(b?.id));
      if (!c || c.status === 'recebido' || c.status === 'cancelado') throw erro('Item de compra não encontrado ou já fechado.');
      const q = Math.round(Number(b?.qtd));
      if (!Number.isFinite(q) || q <= 0) throw erro('Quantidade recebida inválida.');
      const valor = Number(b?.valor_unit) || null;
      const data = dataOuAgora(b?.data);
      D.estoqueMovGravar([{ data, tipo: 'compra', numero: c.numero, qtd: q, valor_unit: valor ?? catalogo().porNumero.get(c.numero)?.custo ?? null,
        origem: c.fornecedor || 'Fornecedor', ref: `compra:${c.id}`, quem: quem(), obs: `Pedido ${c.pedido}` }]);
      const recebido = c.recebido_qtd + q;
      D.compraAtualizar(c.id, { status: recebido >= c.qtd || b?.fechar ? 'recebido' : 'parcial', recebido_qtd: recebido,
        valor_pago: valor ?? c.valor_pago, recebido_em: data.slice(0, 10) });
      return { ok: true, recebido };
    },
    'POST /api/estoque/compras/cancelar': async (_u, b) => {
      const c = D.compraObter(Number(b?.id));
      if (!c || c.status === 'recebido') throw erro('Item não encontrado ou já recebido.');
      D.compraAtualizar(c.id, { status: 'cancelado', recebido_qtd: c.recebido_qtd, valor_pago: c.valor_pago, recebido_em: c.recebido_em });
      return { ok: true };
    },
  };

  // Importar a planilha (só o administrador: usuarios.js não libera esta rota). Bytes crus do .xlsx.
  async function importar(buf) {
    const dados = importacaoDe(X.lerXlsx(buf));
    if (!dados.produtos.length) throw erro('Não achei produtos na aba "Cadastro Produtos".');
    const noCatalogo = new Set(D.catalogoListar().map((p) => p.numero));
    const novos = dados.produtos.filter((p) => !noCatalogo.has(p.numero));
    if (novos.length) D.catalogoGravar(novos.map((p) => ({ numero: p.numero, sku: p.sku, nome: p.nome, custo: p.custo })));
    for (const p of dados.produtos) D.estoqueProdutoGravar(p.numero, p);
    for (const f of dados.fornecedores) D.fornecedorGravar(f);
    const conhecidos = new Set([...noCatalogo, ...novos.map((p) => p.numero)]);
    const movs = dados.movimentos.filter((m) => conhecidos.has(m.numero));
    D.estoqueHistoricoTrocar(movs.map((m) => ({ ...m, quem: 'planilha' })));
    D.comprasDaPlanilhaApagar();
    D.comprasCriar(dados.compras.filter((c) => conhecidos.has(c.numero)));
    D.configGravar('estoque_importado_em', new Date().toISOString());
    return { produtos: dados.produtos.length, produtos_novos: novos.length, fornecedores: dados.fornecedores.length, movimentos: movs.length,
      compras: dados.compras.length, avisos: { ...dados.avisos, sem_produto: dados.movimentos.length - movs.length } };
  }

  return { rotas, rotasParam: [], importar, baixar, lancarVendaManual, estornarRef, catalogo, expandir, visao };
}

module.exports = { criar, numerosDoCodigo, reposicao, importacaoDe, relatorio, periodoDe, diferencas, TIPO_NOME };
