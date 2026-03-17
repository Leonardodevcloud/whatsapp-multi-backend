// src/modules/whatsapp/whatsapp.connection.js
// Conexão WhatsApp via Z-API — HTTP REST puro

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

  get baseUrl() {
    return `${ZAPI_BASE}/${this.instanceId}/token/${this.token}`;
  }

  /**
   * Inicializar com credenciais Z-API
   */
  async conectar() {
    this.instanceId = process.env.ZAPI_INSTANCE_ID;
    this.token = process.env.ZAPI_TOKEN;
    this.securityToken = process.env.ZAPI_SECURITY_TOKEN;

    if (!this.instanceId || !this.token) {
      logger.warn('[WhatsApp] ZAPI_INSTANCE_ID ou ZAPI_TOKEN não configurados — WhatsApp desativado');
      this.status = 'desconectado';
      return;
    }

    try {
      // Verificar status da instância
      const response = await fetch(`${this.baseUrl}/status`, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        logger.error({ status: response.status }, '[WhatsApp] Erro ao verificar Z-API');
        this.status = 'desconectado';
        return;
      }

      const data = await response.json();
      logger.info({ data }, '[WhatsApp] Status Z-API');

      if (data.connected) {
        this.status = 'conectado';
        this.inicioConexao = new Date();
        this.infoUsuario = {
          name: data.smartPhoneConnected ? 'WhatsApp Conectado' : 'Z-API',
          id: this.instanceId,
        };

        // Buscar info do número
        try {
          const phoneResp = await fetch(`${this.baseUrl}/phone`, {
            headers: { 'Content-Type': 'application/json' },
          });
          if (phoneResp.ok) {
            const phoneData = await phoneResp.json();
            if (phoneData.phone) {
              this.infoUsuario.id = phoneData.phone;
              this.infoUsuario.name = phoneData.name || 'WhatsApp Conectado';
            }
          }
        } catch {
          // Não crítico
        }

        logger.info({ nome: this.infoUsuario.name, numero: this.infoUsuario.id }, '[WhatsApp] Z-API conectada!');
        this.emit('conectado', this.infoUsuario);
      } else {
        this.status = 'desconectado';
        logger.warn('[WhatsApp] Z-API instância não conectada — escaneie o QR no painel Z-API');
      }
    } catch (err) {
      logger.error({ err: err.message }, '[WhatsApp] Erro ao conectar Z-API');
      this.status = 'desconectado';
    }
  }

  /**
   * Enviar mensagem de texto via Z-API
   */
  async enviarTexto(telefone, texto) {
    this._verificarConectado();

    const payload = {
      phone: telefone,
      message: texto,
    };

    logger.info({ url: `${this.baseUrl}/send-text`, payload }, '[WhatsApp] Enviando pra Z-API');

    const response = await fetch(`${this.baseUrl}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const responseBody = await response.json().catch(() => ({}));

    if (!response.ok) {
      logger.error({ status: response.status, responseBody, payload }, '[WhatsApp] Z-API rejeitou envio');
      throw new Error(responseBody.message || responseBody.error || `Z-API erro HTTP ${response.status}`);
    }

    logger.info({ telefone, responseBody }, '[WhatsApp] Mensagem enviada');

    return { key: { id: responseBody.zapiMessageId || responseBody.messageId || 'unknown' } };
  }

  /**
   * Enviar imagem via Z-API
   */
  async enviarImagem(telefone, imageUrl, caption) {
    this._verificarConectado();

    const response = await fetch(`${this.baseUrl}/send-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: telefone,
        image: imageUrl,
        caption: caption || '',
      }),
    });

    if (!response.ok) throw new Error(`Erro ao enviar imagem: HTTP ${response.status}`);
    const data = await response.json();
    return { key: { id: data.zapiMessageId || data.messageId } };
  }

  /**
   * Enviar áudio via Z-API
   */
  async enviarAudio(telefone, audioUrl) {
    this._verificarConectado();

    const response = await fetch(`${this.baseUrl}/send-audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: telefone,
        audio: audioUrl,
      }),
    });

    if (!response.ok) throw new Error(`Erro ao enviar áudio: HTTP ${response.status}`);
    const data = await response.json();
    return { key: { id: data.zapiMessageId || data.messageId } };
  }

  /**
   * Enviar documento via Z-API
   */
  async enviarDocumento(telefone, documentUrl, fileName) {
    this._verificarConectado();

    const ext = fileName?.split('.').pop() || 'pdf';
    const response = await fetch(`${this.baseUrl}/send-document/${ext}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: telefone,
        document: documentUrl,
        fileName: fileName || 'arquivo',
      }),
    });

    if (!response.ok) throw new Error(`Erro ao enviar documento: HTTP ${response.status}`);
    const data = await response.json();
    return { key: { id: data.zapiMessageId || data.messageId } };
  }

  /**
   * Marcar mensagem como lida
   */
  async marcarComoLida(messageId, phone) {
    if (this.status !== 'conectado' || !messageId) return;
    try {
      await fetch(`${this.baseUrl}/read-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, phone }),
      });
    } catch {
      // Não crítico
    }
  }

  _verificarConectado() {
    if (this.status !== 'conectado') {
      throw new Error('WhatsApp Z-API não está conectada');
    }
  }

  obterStatus() {
    return {
      status: this.status,
      conectado: this.status === 'conectado',
      tipo: 'z-api',
      tempoOnline: this.inicioConexao
        ? Math.floor((Date.now() - this.inicioConexao.getTime()) / 1000)
        : 0,
      usuario: this.infoUsuario,
      qrDisponivel: false, // QR é pelo painel Z-API
    };
  }

  async desconectar() {
    this.status = 'desconectado';
    this.inicioConexao = null;
    logger.info('[WhatsApp] Z-API desconectada');
  }
}

const conexaoWA = new WhatsAppConnection();
module.exports = conexaoWA;