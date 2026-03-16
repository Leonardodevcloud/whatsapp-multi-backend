// src/modules/whatsapp/whatsapp.connection.js
// Gerenciamento de conexão Baileys — sessão PostgreSQL, reconexão, QR, eventos

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  isJidStatusBroadcast,
} = require('@whiskeysockets/baileys');
const { EventEmitter } = require('events');
const { query } = require('../../config/database');
const logger = require('../../shared/logger');

class WhatsAppConnection extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.status = 'desconectado'; // desconectado | escaneando_qr | conectado
    this.qrCode = null;
    this.tentativasReconexao = 0;
    this.maxTentativas = 10;
    this.timerReconexao = null;
    this.inicioConexao = null;
    this.infoUsuario = null;
  }

  /**
   * Auth state persistido no PostgreSQL (tabela whatsapp_sessoes)
   * Substitui arquivo local — essencial para containers Railway
   */
  async usePostgresAuthState() {
    const SESSAO_ID = 'principal';

    const writeData = async (id, dados) => {
      const valor = JSON.stringify(dados, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      );
      await query(
        `INSERT INTO whatsapp_sessoes (sessao_id, dados, atualizado_em)
         VALUES ($1, $2, NOW())
         ON CONFLICT (sessao_id)
         DO UPDATE SET dados = $2, atualizado_em = NOW()`,
        [`${SESSAO_ID}:${id}`, valor]
      );
    };

    const readData = async (id) => {
      try {
        const resultado = await query(
          `SELECT dados FROM whatsapp_sessoes WHERE sessao_id = $1`,
          [`${SESSAO_ID}:${id}`]
        );
        if (resultado.rows.length === 0) return null;
        return typeof resultado.rows[0].dados === 'string'
          ? JSON.parse(resultado.rows[0].dados)
          : resultado.rows[0].dados;
      } catch {
        return null;
      }
    };

    const removeData = async (id) => {
      await query(`DELETE FROM whatsapp_sessoes WHERE sessao_id = $1`, [`${SESSAO_ID}:${id}`]);
    };

    // Carregar creds existentes
    const creds = await readData('creds');

    return {
      state: {
        creds: creds || undefined,
        keys: makeCacheableSignalKeyStore(
          {
            get: async (type, ids) => {
              const dados = {};
              for (const id of ids) {
                const valor = await readData(`${type}-${id}`);
                if (valor) dados[id] = valor;
              }
              return dados;
            },
            set: async (data) => {
              for (const [type, entries] of Object.entries(data)) {
                for (const [id, valor] of Object.entries(entries)) {
                  if (valor) {
                    await writeData(`${type}-${id}`, valor);
                  } else {
                    await removeData(`${type}-${id}`);
                  }
                }
              }
            },
          },
          logger.child({ modulo: 'signal-keys' })
        ),
      },
      saveCreds: async () => {
        if (this.sock?.authState?.creds) {
          await writeData('creds', this.sock.authState.creds);
        }
      },
    };
  }

  /**
   * Iniciar conexão WhatsApp
   */
  async conectar() {
    try {
      const { version } = await fetchLatestBaileysVersion();
      logger.info({ version }, '[WhatsApp] Versão Baileys');

      const { state, saveCreds } = await this.usePostgresAuthState();

      // Logger silencioso pra Baileys — evita uncaught exceptions
      const baileysLogger = {
        level: 'silent',
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {},
        child: () => baileysLogger,
      };

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: baileysLogger,
        browser: ['Central Tutts WA', 'Chrome', '120.0.0'],
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        getMessage: async () => undefined,
      });

      // Salvar credenciais quando atualizadas
      this.sock.ev.on('creds.update', saveCreds);

      // Evento de atualização de conexão
      this.sock.ev.on('connection.update', (update) => {
        this._handleConnectionUpdate(update);
      });

      // Mensagens recebidas
      this.sock.ev.on('messages.upsert', (msg) => {
        this._handleMessagesUpsert(msg);
      });

      // Status de mensagem (entregue, lida)
      this.sock.ev.on('messages.update', (updates) => {
        this.emit('messages.update', updates);
      });

      logger.info('[WhatsApp] Socket criado, aguardando conexão...');
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, '[WhatsApp] Erro ao iniciar conexão');
      this._agendarReconexao();
    }
  }

  /**
   * Handler de atualização de conexão
   */
  _handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qrCode = qr;
      this.status = 'escaneando_qr';
      this.emit('qr', qr);
      logger.info('[WhatsApp] Novo QR code gerado');
    }

    if (connection === 'close') {
      this.status = 'desconectado';
      this.qrCode = null;
      this.inicioConexao = null;
      this.infoUsuario = null;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const motivo = DisconnectReason[statusCode] || statusCode;

      logger.warn({ statusCode, motivo }, '[WhatsApp] Conexão fechada');

      // 401 = Logged out (QR invalidado) — limpar sessão e reconectar
      if (statusCode === DisconnectReason.loggedOut) {
        logger.info('[WhatsApp] Sessão invalidada, limpando dados...');
        this._limparSessao().then(() => this._agendarReconexao());
        return;
      }

      // 515 = Restart required
      // Qualquer outro erro = tentar reconectar
      if (statusCode !== DisconnectReason.loggedOut) {
        this._agendarReconexao();
      }

      this.emit('desconectado', { statusCode, motivo });
    }

    if (connection === 'open') {
      this.status = 'conectado';
      this.qrCode = null;
      this.tentativasReconexao = 0;
      this.inicioConexao = new Date();
      this.infoUsuario = this.sock?.user || null;

      logger.info(
        { usuario: this.infoUsuario?.name, numero: this.infoUsuario?.id },
        '[WhatsApp] Conectado com sucesso!'
      );

      this.emit('conectado', this.infoUsuario);
    }
  }

  /**
   * Handler de mensagens recebidas
   */
  _handleMessagesUpsert({ messages, type }) {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Ignorar broadcasts e status
      if (!msg.key?.remoteJid) continue;
      if (isJidBroadcast(msg.key.remoteJid)) continue;
      if (isJidStatusBroadcast(msg.key.remoteJid)) continue;

      // Ignorar mensagens de grupo (por enquanto)
      if (msg.key.remoteJid.endsWith('@g.us')) continue;

      // Ignorar mensagens do próprio bot (enviadas por nós)
      if (msg.key.fromMe) {
        this.emit('mensagem.enviada', msg);
        continue;
      }

      this.emit('mensagem.recebida', msg);
    }
  }

  /**
   * Reconexão com backoff exponencial
   */
  _agendarReconexao() {
    if (this.tentativasReconexao >= this.maxTentativas) {
      logger.error('[WhatsApp] Máximo de tentativas de reconexão atingido');
      this.emit('reconexao.falhou');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.tentativasReconexao), 60000);
    this.tentativasReconexao++;

    logger.info(
      { tentativa: this.tentativasReconexao, delay: `${delay}ms` },
      '[WhatsApp] Agendando reconexão...'
    );

    if (this.timerReconexao) clearTimeout(this.timerReconexao);

    this.timerReconexao = setTimeout(() => {
      this.conectar();
    }, delay);
  }

  /**
   * Limpar dados de sessão no PostgreSQL
   */
  async _limparSessao() {
    try {
      await query(`DELETE FROM whatsapp_sessoes WHERE sessao_id LIKE 'principal:%'`);
      logger.info('[WhatsApp] Dados de sessão removidos');
    } catch (err) {
      logger.error({ err }, '[WhatsApp] Erro ao limpar sessão');
    }
  }

  /**
   * Enviar mensagem de texto
   */
  async enviarTexto(jid, texto) {
    if (this.status !== 'conectado' || !this.sock) {
      throw new Error('WhatsApp não está conectado');
    }
    return this.sock.sendMessage(jid, { text: texto });
  }

  /**
   * Enviar mídia (imagem, audio, video, documento)
   */
  async enviarMidia(jid, tipo, buffer, opcoes = {}) {
    if (this.status !== 'conectado' || !this.sock) {
      throw new Error('WhatsApp não está conectado');
    }

    const payload = {};
    switch (tipo) {
      case 'imagem':
        payload.image = buffer;
        if (opcoes.caption) payload.caption = opcoes.caption;
        break;
      case 'audio':
        payload.audio = buffer;
        payload.mimetype = 'audio/ogg; codecs=opus';
        payload.ptt = opcoes.ptt !== false;
        break;
      case 'video':
        payload.video = buffer;
        if (opcoes.caption) payload.caption = opcoes.caption;
        break;
      case 'documento':
        payload.document = buffer;
        payload.mimetype = opcoes.mimetype || 'application/octet-stream';
        payload.fileName = opcoes.fileName || 'arquivo';
        break;
      default:
        throw new Error(`Tipo de mídia não suportado: ${tipo}`);
    }

    return this.sock.sendMessage(jid, payload);
  }

  /**
   * Marcar mensagem como lida
   */
  async marcarComoLida(jid, messageKeys) {
    if (this.status !== 'conectado' || !this.sock) return;
    try {
      await this.sock.readMessages(messageKeys);
    } catch (err) {
      logger.error({ err, jid }, '[WhatsApp] Erro ao marcar como lida');
    }
  }

  /**
   * Obter status da conexão para health check
   */
  obterStatus() {
    return {
      status: this.status,
      conectado: this.status === 'conectado',
      tempoOnline: this.inicioConexao
        ? Math.floor((Date.now() - this.inicioConexao.getTime()) / 1000)
        : 0,
      usuario: this.infoUsuario
        ? { nome: this.infoUsuario.name, numero: this.infoUsuario.id }
        : null,
      tentativasReconexao: this.tentativasReconexao,
      qrDisponivel: !!this.qrCode,
    };
  }

  /**
   * Desconectar gracefully
   */
  async desconectar() {
    if (this.timerReconexao) {
      clearTimeout(this.timerReconexao);
      this.timerReconexao = null;
    }

    if (this.sock) {
      try {
        await this.sock.end();
      } catch {
        // Ignorar erros no shutdown
      }
      this.sock = null;
    }

    this.status = 'desconectado';
    this.qrCode = null;
    logger.info('[WhatsApp] Desconectado gracefully');
  }

  /**
   * Forçar logout (invalidar sessão)
   */
  async forcarLogout() {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        // Ignorar
      }
    }
    await this._limparSessao();
    await this.desconectar();
    logger.info('[WhatsApp] Logout forçado — sessão removida');
  }
}

// Singleton
const conexaoWA = new WhatsAppConnection();

module.exports = conexaoWA;