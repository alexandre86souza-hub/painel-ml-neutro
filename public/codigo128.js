// Código de barras Code 128 (conjunto B: letras, números e símbolos) em SVG, para o número do
// pedido nas comandas. Sem biblioteca: tabela padrão de 107 símbolos (larguras barra/espaço).
// Funciona no navegador (window.codigo128Svg) e no Node (testado em test-comandas.js).
(function () {
  const P = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 '
    + '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 '
    + '111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 '
    + '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 '
    + '141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 '
    + '124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 '
    + '311141 411131 211412 211214 211232 2331112').split(' ');
  // larguras (módulos) dos símbolos do texto: início B, dados, verificador e parada
  function larguras(texto) {
    const s = String(texto);
    if (!s.length || [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126)) return null;
    const vals = [...s].map((c) => c.charCodeAt(0) - 32);
    const soma = vals.reduce((a, v, i) => a + v * (i + 1), 104);
    return [104, ...vals, soma % 103, 106].map((v) => P[v]).join('');
  }
  function codigo128Svg(texto, altura = 50) {
    const w = larguras(texto);
    if (!w) return '';
    let x = 10, barras = '';
    [...w].forEach((d, i) => { const n = Number(d); if (i % 2 === 0) barras += `<rect x="${x}" y="0" width="${n}" height="${altura}"/>`; x += n; });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x + 10} ${altura}" preserveAspectRatio="none" role="img" aria-label="Código de barras ${String(texto).replace(/[<&"]/g, '')}"><g fill="#000">${barras}</g></svg>`;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { larguras, codigo128Svg, PADROES: P };
  else window.codigo128Svg = codigo128Svg;
})();
