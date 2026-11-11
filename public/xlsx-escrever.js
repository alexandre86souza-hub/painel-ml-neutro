'use strict';
// Escritor mínimo de planilha .xlsx (sem biblioteca, ZIP sem compressão), para o navegador e para o teste em Node.
// xlsxDe({ aba, linhas, larguras }) -> Uint8Array. Célula: texto, número, null (vazia) ou { v, e } com estilo e:
// 'neg' (negrito), 'cab' (cabeçalho: negrito, fundo cinza, borda), 'borda' (com borda). Testado em test-estoque.js.
(function (raiz) {
  const enc = new TextEncoder();
  const tab = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xFFFFFFFF; for (const v of b) c = tab[(c ^ v) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(arquivos) {
    const partes = [], central = []; let pos = 0;
    for (const a of arquivos) {
      const nome = enc.encode(a.nome), dados = enc.encode(a.texto), c = crc(dados);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);   // 0x0800 = nomes em UTF-8
      lh.setUint32(14, c, true); lh.setUint32(18, dados.length, true); lh.setUint32(22, dados.length, true); lh.setUint16(26, nome.length, true);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint32(16, c, true); ch.setUint32(20, dados.length, true); ch.setUint32(24, dados.length, true); ch.setUint16(28, nome.length, true);
      ch.setUint32(42, pos, true);
      partes.push(new Uint8Array(lh.buffer), nome, dados); central.push(new Uint8Array(ch.buffer), nome);
      pos += 30 + nome.length + dados.length;
    }
    const tamC = central.reduce((s, p) => s + p.length, 0);
    const fim = new DataView(new ArrayBuffer(22));
    fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, arquivos.length, true); fim.setUint16(10, arquivos.length, true);
    fim.setUint32(12, tamC, true); fim.setUint32(16, pos, true);
    const todas = [...partes, ...central, new Uint8Array(fim.buffer)];
    const out = new Uint8Array(todas.reduce((s, p) => s + p.length, 0)); let o = 0;
    for (const p of todas) { out.set(p, o); o += p.length; }
    return out;
  }
  const esc = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const letra = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  const ESTILO = { neg: 1, cab: 2, borda: 3 };
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  function xlsxDe({ aba = 'Planilha', linhas = [], larguras = [] } = {}) {
    const rows = linhas.map((l, r) => {
      const cels = (l || []).map((c, i) => {
        if (c == null || c === '') return '';
        const v = typeof c === 'object' ? c.v : c, s = typeof c === 'object' && ESTILO[c.e] ? ` s="${ESTILO[c.e]}"` : '';
        const ref = `${letra(i)}${r + 1}`;
        if (v == null || v === '') return `<c r="${ref}"${s}/>`;
        return typeof v === 'number' && Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>`
          : `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cels}</row>`;
    }).join('');
    const cols = larguras.length ? `<cols>${larguras.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const nomeAba = esc(String(aba).replace(/[\/?*[\]:]/g, ' ').slice(0, 31) || 'Planilha');
    return zip([
      { nome: '[Content_Types].xml', texto: XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { nome: '_rels/.rels', texto: XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { nome: 'xl/workbook.xml', texto: XML + `<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${nomeAba}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { nome: 'xl/_rels/workbook.xml.rels', texto: XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { nome: 'xl/styles.xml', texto: XML + `<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/></cellXfs></styleSheet>` },
      { nome: 'xl/worksheets/sheet1.xml', texto: XML + `<worksheet xmlns="${NS}">${cols}<sheetData>${rows}</sheetData></worksheet>` },
    ]);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { xlsxDe };
  else raiz.xlsxDe = xlsxDe;
})(typeof window !== 'undefined' ? window : globalThis);
