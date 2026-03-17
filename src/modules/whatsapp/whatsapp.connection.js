// src/modules/whatsapp/whatsapp.connection.js
// WhatsApp Cloud API (Meta) — sem Baileys, HTTP puro

const { EventEmitter } = require('events');
const logger = require('../../shared/logger');

const GRAPH_API = 'https://graph.facebook.com/v21.0';

class WhatsAppConnection extends EventEmitter {
  constructor() {
    super();
    this.status = 'desconectado';
    this.inicioConexao = null;
    this.infoUsuario = null;
    this.phoneNumberId = null;
    this.accessToken = null;
    this.webhookVerifyToken = null;
  }

  /**
   * Inicializar com credenciais da Meta
   */
  async conectar() {
    this.phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
    this.accessToken = process.env.WA_ACCESS_TOKEN;
    this.webhookVerifyToken = process.env.WA_WEBHOOK_VERIFY_TOKEN || 'centraltutts_webhook_2026';

    if (!this.phoneNumberId || !this.accessToken) {
      logger.warn('[WhatsApp] WA_PHONE_NUMBER_ID ou WA_ACCESS_TOKEN não configurados — WhatsApp desativado');
      this.status = 'desconectado';
      return;
    }

    try {
      const response = await fetch(`${GRAPH_API}/${this.phoneNumberId}`, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` },
      });

      if (!response.ok) {
        const erro = await response.text();
        logger.error({ status: response.status, erro }, '[WhatsApp] Credenciais inválidas');
        this.status = 'desconectado';
        return;
      }

      const data = await response.json();
      this.infoUsuario = {
        name: data.verified_name || data.display_phone_number || 'WhatsApp Business',
        id: data.display_phone_number || this.phoneNumberId,
      };
      this.status = 'conectado';
      this.inicioConexao = new Date();

      logger.info({ nome: this.infoUsuario.name, numero: this.infoUsuario.id }, '[WhatsApp] Cloud API conectada!');
      this.emit('conectado', this.infoUsuario);
    } catch (err) {
      logger.error({ err: err.message }, '[WhatsApp] Erro ao conectar Cloud API');
      this.status = 'desconectado';
    }
  }

  /**
   * Enviar mensagem de texto
   */
  async enviarTexto(telefone, texto) {
    this._verificarConectado();

    const data = await this._chamarAPI('messages', {
      messaging_product: 'whatsapp',
      to: telefone,
      type: 'text',
      text: { body: texto },
    });

    const waMessageId = data.messages?.[0]?.id;
    logger.info({ telefone, waMessageId }, '[WhatsApp] Mensagem enviada');
    return { key: { id: waMessageId } };
  }

  /**
   * Enviar mídia
   */
  async enviarMidia(telefone, tipo, mediaUrl, opcoes = {}) {
    this._verificarConectado();

    const payload = { messaging_product: 'whatsapp', to: telefone };

    switch (tipo) {
      case 'imagem':
        payload.type = 'image';
        payload.image = { link: mediaUrl, ...(opcoes.caption && { caption: opcoes.caption }) };
        break;
      case 'audio':
        payload.type = 'audio';
        payload.audio = { link: mediaUrl };
        break;
      case 'video':
        payload.type = 'video';
        payload.video = { link: mediaUrl, ...(opcoes.caption && { caption: opcoes.caption }) };
        break;
      case 'documento':
        payload.type = 'document';
        payload.document = { link: mediaUrl, filename: opcoes.fileName || 'arquivo' };
        break;
      default:
        throw new Error(`Tipo não suportado: ${tipo}`);
    }

    const data = await this._chamarAPI('messages', payload);
    return { key: { id: data.messages?.[0]?.id } };
  }

  /**
   * Marcar mensagem como lida
   */
  async marcarComoLida(waMessageId) {
    if (this.status !== 'conectado' || !waMessageId) return;
    try {
      await this._chamarAPI('messages', {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: waMessageId,
      });
    } catch {
      // Não crítico
    }
  }

  /**
   * Chamar Graph API
   */
  async _chamarAPI(endpoint, body) {
    const response = await fetch(`${GRAPH_API}/${this.phoneNumberId}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const erro = await response.json().catch(() => ({}));
      const msg = erro.error?.message || `HTTP ${response.status}`;
      logger.error({ erro: msg, endpoint }, '[WhatsApp] Erro na API');
      throw new Error(msg);
    }

    return response.json();
  }

  _verificarConectado() {
    if (this.status !== 'conectado') {
      throw new Error('WhatsApp Cloud API não está conectada');
    }
  }

  obterStatus() {
    return {
      status: this.status,
      conectado: this.status === 'conectado',
      tipo: 'cloud_api',
      tempoOnline: this.inicioConexao
        ? Math.floor((Date.now() - this.inicioConexao.getTime()) / 1000)
        : 0,
      usuario: this.infoUsuario,
      qrDisponivel: false,
    };
  }

  async desconectar() {
    this.status = 'desconectado';
    this.inicioConexao = null;
    logger.info('[WhatsApp] Desconectado');
  }
}

const conexaoWA = new WhatsAppConnection();
module.exports = conexaoWA;