// src/shared/businessTime.js
// Calcula tempo decorrido apenas em horário comercial
// Seg-Sex: 08:00 - 18:59 (11h), Sáb: 08:00 - 11:59 (4h), Dom: 0h
// Timezone: America/Bahia (UTC-3)

const BAHIA_OFFSET_H = -3;
const MS_HORA = 3600000;
const MS_DIA = 86400000;

// Converte UTC epoch → Bahia epoch (pra usar getUTCHours/getUTCDay como se fosse local)
function _utcToBahia(ms) { return ms + BAHIA_OFFSET_H * MS_HORA; }

// Horário comercial por dia da semana (getUTCDay: 0=dom, 6=sab)
function _janela(dow) {
  if (dow === 0) return null;           // domingo
  if (dow === 6) return [8, 12];        // sábado 08-12
  return [8, 19];                        // seg-sex 08-19
}

/**
 * Calcula segundos em horário comercial entre inicio e fim
 * @param {Date|string|number} inicio
 * @param {Date|string|number} fim - default: agora
 * @returns {number} segundos em horário comercial
 */
function calcularTempoComercial(inicio, fim) {
  const msInicio = new Date(inicio).getTime();
  const msFim = fim ? new Date(fim).getTime() : Date.now();
  if (msFim <= msInicio) return 0;

  // Converter pra "Bahia epoch" — getUTC* retorna hora/dia em Bahia
  const bInicio = _utcToBahia(msInicio);
  const bFim = _utcToBahia(msFim);

  // Encontrar o início do dia (meia-noite Bahia) do primeiro e último dia
  const diaInicio = new Date(bInicio);
  diaInicio.setUTCHours(0, 0, 0, 0);
  const primeiroDiaMs = diaInicio.getTime();

  const diaFim = new Date(bFim);
  diaFim.setUTCHours(0, 0, 0, 0);
  const ultimoDiaMs = diaFim.getTime();

  const numDias = Math.round((ultimoDiaMs - primeiroDiaMs) / MS_DIA) + 1;
  let totalSeg = 0;

  for (let d = 0; d < numDias; d++) {
    const diaMs = primeiroDiaMs + d * MS_DIA;
    const dow = new Date(diaMs).getUTCDay();
    const janela = _janela(dow);
    if (!janela) continue;

    const [hIni, hFim] = janela;
    const janelaIniMs = diaMs + hIni * MS_HORA;
    const janelaFimMs = diaMs + hFim * MS_HORA;

    // Intersecção entre [bInicio, bFim] e [janelaIni, janelaFim]
    const efInicio = Math.max(bInicio, janelaIniMs);
    const efFim = Math.min(bFim, janelaFimMs);

    if (efFim > efInicio) {
      totalSeg += Math.floor((efFim - efInicio) / 1000);
    }
  }

  return Math.max(totalSeg, 0);
}

module.exports = { calcularTempoComercial };
