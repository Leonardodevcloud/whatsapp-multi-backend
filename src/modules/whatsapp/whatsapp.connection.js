// src/modules/whatsapp/whatsapp.connection.js
// Conexão WhatsApp via Z-API — com quote/reply e edição

const { EventEmitter } = require('events');
const logger = require('../../shared/logger');

const ZAPI_BASE = 'https://api.z-api.io/instances';

class WhatsAppConnection extends EventEmitter {
  constructor() {
    super();
    this.status = 'desconectado';
    this.inicioConexao = null;
    this.infoUsuario = null;
    this.instanceId = null;
    this.token = null;
    this.securityToken = null;
  }

  get baseUrl() { return `${ZAPI_BASE}/${this.instanceId}/token/${this.token}`; }

  get headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.securityToken) h['Client-Token'] = this.securityToken;
    return h;
  }

  async conectar() {
    this.instanceId = process.env.ZAPI_INSTANCE_ID;
    this.token = process.env.ZAPI_TOKEN;
    this.securityToken = process.env.ZAPI_SECURITY_TOKEN || null;

    if (!this.instanceId || !this.token) {
      logger.warn('[WhatsApp] ZAPI_INSTANCE_ID ou ZAPI_TOKEN não configurados');
      this.status = 'desconectado';
      return;
    }

    try {
      const response = await fetch(`${this.baseUrl}/status`, { headers: this.headers });
      if (!response.ok) {
        const errBody = await response.text();
        logger.error({ status: response.status, errBody }, '[WhatsApp] Erro ao verificar Z-API');
        this.status = 'desconectado';
        return;
      }

      const data = await response.json();
      logger.info({ data }, '[WhatsApp] Status Z-API');

      if (data.connected === true || data.smartphoneConnected === true) {
        this.status = 'conectado';
        this.inicioConexao = new Date();
        this.infoUsuario = { phone: data.phoneConnected || 'Z-API' };
        this.emit('conectado');
        logger.info('[WhatsApp] Z-API conectada!');
      } else {
        this.status = 'desconectado';
        logger.warn('[WhatsApp] Z-API não conectada ao telefone');
      }
    } catch (err) {
      logger.error({ err: err.message }, '[WhatsApp] Erro ao conectar Z-API');
      this.status = 'desconectado';
    }
  }

  async enviarTexto(telefone, texto, opts = {}) {
    this._verificarConectado();
    const payload = { phone: telefone, message: texto };

    // Quote/Reply — Z-API aceita messageId pra citar
    if (opts.quotedMessageId) {
      payload.messageId = opts.quotedMessageId;
    }

    logger.info({ telefone, textoLen: texto.length, quote: !!opts.quotedMessageId }, '[WhatsApp] Enviando texto');

    const response = await fetch(`${this.baseUrl}/send-text`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    });

    const responseBody = await response.json().catch(() => ({}));

    if (!response.ok) {
      logger.error({ status: response.status, responseBody, telefone }, '[WhatsApp] Z-API rejeitou');
      throw new Error(responseBody.message || responseBody.error || `Z-API HTTP ${response.status}`);
    }

    logger.info({ responseBody }, '[WhatsApp] Resposta Z-API');
    return { key: { id: responseBody.zapiMessageId || responseBody.messageId || 'sent' } };
  }

  async enviarImagem(telefone, imageUrl, caption) {
    this._verificarConectado();
    const resp = await fetch(`${this.baseUrl}/send-image`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ phone: telefone, image: imageUrl, caption: caption || '' }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || `HTTP ${resp.status}`);
    return { key: { id: data.zapiMessageId || data.messageId || 'sent' } };
  }

  async enviarAudio(telefone, audioUrl) {
    this._verificarConectado();
    const resp = await fetch(`${this.baseUrl}/send-audio`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ phone: telefone, audio: audioUrl }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || `HTTP ${resp.status}`);
    return { key: { id: data.zapiMessageId || data.messageId || 'sent' } };
  }

  async enviarVideo(telefone, videoUrl, caption) {
    this._verificarConectado();
    const resp = await fetch(`${this.baseUrl}/send-video`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ phone: telefone, video: videoUrl, caption: caption || '' }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || `HTTP ${resp.status}`);
    return { key: { id: data.zapiMessageId || data.messageId || 'sent' } };
  }

  async enviarDocumento(telefone, documentUrl, fileName) {
    this._verificarConectado();
    const resp = await fetch(`${this.baseUrl}/send-document/pdf`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ phone: telefone, document: documentUrl, fileName: fileName || 'documento' }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || `HTTP ${resp.status}`);
    return { key: { id: data.zapiMessageId || data.messageId || 'sent' } };
  }

  async marcarComoLida(messageId, phone) {
    if (this.status !== 'conectado' || !messageId) return;
    try {
      await fetch(`${this.baseUrl}/read-message`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ messageId, phone }),
      });
    } catch { }
  }

  async reagirMensagem(messageId, phone, emoji) {
    this._verificarConectado();
    const resp = await fetch(`${this.baseUrl}/send-reaction`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ messageId, phone, reaction: emoji }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || `HTTP ${resp.status}`);
    return data;
  }

  async deletarMensagem(messageId, phone) {
    this._verificarConectado();
    const resp = await fetch(`${this.baseUrl}/delete-message`, {
      method: 'DELETE',
      headers: this.headers,
      body: JSON.stringify({ messageId, phone, owner: true }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || `HTTP ${resp.status}`);
    return data;
  }

  /**
   * Editar mensagem enviada — Z-API update-message
   */
  async editarMensagem(messageId, phone, novoTexto) {
    this._verificarConectado();
    const resp = await fetch(`${this.baseUrl}/update-message`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ messageId, phone, message: novoTexto }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      logger.error({ status: resp.status, data, messageId }, '[WA] Erro update-message');
      throw new Error(data.message || `HTTP ${resp.status}`);
    }
    logger.info({ messageId }, '[WA] Mensagem editada');
    return data;
  }

  async encaminharMensagem(messageId, phoneOrigem, phoneTo) {
    this._verificarConectado();
    const resp = await fetch(`${this.baseUrl}/forward-message`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ messageId, phone: phoneOrigem, phoneTo }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      logger.error({ status: resp.status, data, messageId, phoneOrigem, phoneTo }, '[WA] Erro forward-message');
      throw new Error(data.message || `HTTP ${resp.status}`);
    }
    return data;
  }

  async enviarSticker(telefone, stickerUrl) {
    this._verificarConectado();
    const resp = await fetch(`${this.baseUrl}/send-sticker`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ phone: telefone, sticker: stickerUrl }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || `HTTP ${resp.status}`);
    return { key: { id: data.zapiMessageId || data.messageId || 'sent' } };
  }

  async enviarLink(telefone, url, mensagem) {
    this._verificarConectado();
    const resp = await fetch(`${this.baseUrl}/send-link`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ phone: telefone, message: mensagem || '', image: '', linkUrl: url, title: '', linkDescription: '' }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || `HTTP ${resp.status}`);
    return { key: { id: data.zapiMessageId || data.messageId || 'sent' } };
  }

  _verificarConectado() {
    if (this.status !== 'conectado') {
      if (this.instanceId && this.token) { this.status = 'conectado'; return; }
      throw new Error('WhatsApp Z-API não conectada');
    }
  }

  obterStatus() {
    return {
      status: this.status,
      conectado: this.status === 'conectado',
      tipo: 'z-api',
      tempoOnline: this.inicioConexao ? Math.floor((Date.now() - this.inicioConexao.getTime()) / 1000) : 0,
      usuario: this.infoUsuario,
      qrDisponivel: false,
    };
  }

  async desconectar() {
    this.status = 'desconectado';
    this.inicioConexao = null;
    logger.info('[WhatsApp] Desconectada');
  }
}

const conexaoWA = new WhatsAppConnection();
module.exports = conexaoWA;
