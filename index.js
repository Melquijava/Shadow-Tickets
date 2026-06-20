require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Colors,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const REQUIRED_ENV = [
  'TOKEN',
  'GUILD_ID',
  'OPEN_TICKET_CHANNEL_ID',
  'SUPORTE_CHANNEL_ID',
  'REEMBOLSOS_CHANNEL_ID',
  'EVENTOS_CHANNEL_ID',
  'VAGAS_MEDIADORES_CHANNEL_ID',
  'STAFF_ROLE_ID',
  'MEDIADOR_ROLE_ID',
  'MEDIADORES_CADASTRADOS_CHANNEL_ID',
  'LOG_CHANNEL_ID',
  'DATA_ENCRYPTION_KEY',
];

const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`Preencha no .env: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const config = {
  token: process.env.TOKEN,
  guildId: process.env.GUILD_ID,
  categoryId: process.env.TICKET_CATEGORY_ID || null,
  panelChannelId: process.env.OPEN_TICKET_CHANNEL_ID,
  staffRoleId: process.env.STAFF_ROLE_ID,
  mediatorRoleId: process.env.MEDIADOR_ROLE_ID,
  ownerRoleId: process.env.OWNER_ROLE_ID || null,
  ownerUserId: process.env.DONO_USER_ID || null,
  registeredMediatorsChannelId: process.env.MEDIADORES_CADASTRADOS_CHANNEL_ID,
  mediatorsPanelChannelId:
    process.env.MEDIADORES_PANEL_CHANNEL_ID || process.env.MEDIADORES_CADASTRADOS_CHANNEL_ID,
  logChannelId: process.env.LOG_CHANNEL_ID,
  mediatorsLogChannelId: process.env.LOG_MEDIADORES_CHANNEL_ID || process.env.LOG_CHANNEL_ID,
};

if (!config.ownerRoleId && !config.ownerUserId) {
  console.error('Preencha ao menos uma variável: OWNER_ROLE_ID ou DONO_USER_ID.');
  process.exit(1);
}

function loadEncryptionKey(value) {
  const trimmed = value.trim();
  if (/^[a-f\d]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  if (/^[A-Za-z\d+/]{43}=$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === 32) return decoded;
  }
  if (trimmed.length < 32) {
    throw new Error('DATA_ENCRYPTION_KEY deve ter pelo menos 32 caracteres.');
  }
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
}

const DATA_ENCRYPTION_KEY = loadEncryptionKey(process.env.DATA_ENCRYPTION_KEY);
const DATA_DIR = process.env.DATA_DIR?.trim() ||
  (process.env.RAILWAY_ENVIRONMENT ? '/data' : __dirname);
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATABASE_PATH = path.join(DATA_DIR, 'tickets.db');

const TICKET_TYPES = {
  suporte: {
    label: 'Suporte',
    emoji: '🛠️',
    prefix: 'suporte',
    channelId: process.env.SUPORTE_CHANNEL_ID,
    color: 0x5865f2,
    description: 'Nossa equipe de suporte analisará sua solicitação em breve.',
  },
  reembolso: {
    label: 'Reembolsos',
    emoji: '💰',
    prefix: 'reembolso',
    channelId: process.env.REEMBOLSOS_CHANNEL_ID,
    color: 0x57f287,
    description: 'Envie os comprovantes e detalhes necessários para a análise do reembolso.',
  },
  evento: {
    label: 'Receber Evento',
    emoji: '🎉',
    prefix: 'evento',
    channelId: process.env.EVENTOS_CHANNEL_ID,
    color: 0xfee75c,
    description: 'Conte para nossa equipe os detalhes do evento que deseja receber.',
  },
  mediador: {
    label: 'Vagas Mediadores',
    emoji: '👻',
    prefix: 'mediador',
    channelId: process.env.VAGAS_MEDIADORES_CHANNEL_ID,
    color: 0xeb459e,
    description: 'Apresente-se e aguarde a avaliação da equipe responsável pelas vagas.',
  },
};

const db = new Database(DATABASE_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    responsible_id TEXT,
    status TEXT NOT NULL DEFAULT 'aberto' CHECK(status IN ('aberto', 'fechado')),
    created_at TEXT NOT NULL,
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS ticket_members (
    ticket_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (ticket_id, user_id),
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS mediator_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    real_name TEXT NOT NULL,
    cpf_encrypted TEXT NOT NULL,
    address_encrypted TEXT NOT NULL,
    age INTEGER NOT NULL,
    experience TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente', 'aprovado', 'recusado')),
    registered_at TEXT NOT NULL,
    reviewed_by TEXT,
    reviewed_at TEXT,
    refusal_reason TEXT,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS mediator_registry (
    user_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mediator_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON tickets(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_mediator_applications_user ON mediator_applications(user_id);
  CREATE INDEX IF NOT EXISTS idx_mediator_history_user_date
    ON mediator_history(user_id, created_at DESC);
`);

const queries = {
  createTicket: db.prepare(`
    INSERT INTO tickets (thread_id, user_id, type, created_at)
    VALUES (?, ?, ?, ?)
  `),
  byThread: db.prepare('SELECT * FROM tickets WHERE thread_id = ?'),
  openByUserType: db.prepare(
    "SELECT * FROM tickets WHERE user_id = ? AND type = ? AND status = 'aberto' LIMIT 1",
  ),
  assume: db.prepare('UPDATE tickets SET responsible_id = ? WHERE id = ?'),
  transferThread: db.prepare('UPDATE tickets SET thread_id = ?, type = ? WHERE id = ?'),
  close: db.prepare(
    "UPDATE tickets SET status = 'fechado', closed_at = ? WHERE id = ? AND status = 'aberto'",
  ),
  addMember: db.prepare('INSERT OR IGNORE INTO ticket_members (ticket_id, user_id) VALUES (?, ?)'),
  removeMember: db.prepare('DELETE FROM ticket_members WHERE ticket_id = ? AND user_id = ?'),
  members: db.prepare('SELECT user_id FROM ticket_members WHERE ticket_id = ?'),
  createMediatorApplication: db.prepare(`
    INSERT INTO mediator_applications (
      ticket_id, user_id, real_name, cpf_encrypted, address_encrypted,
      age, experience, registered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  mediatorByTicket: db.prepare('SELECT * FROM mediator_applications WHERE ticket_id = ?'),
  mediatorByUser: db.prepare(`
    SELECT * FROM mediator_applications
    WHERE user_id = ?
    ORDER BY id DESC LIMIT 1
  `),
  approveMediator: db.prepare(`
    UPDATE mediator_applications
    SET status = 'aprovado', reviewed_by = ?, reviewed_at = ?, refusal_reason = NULL
    WHERE ticket_id = ? AND status = 'pendente'
  `),
  refuseMediator: db.prepare(`
    UPDATE mediator_applications
    SET status = 'recusado', reviewed_by = ?, reviewed_at = ?, refusal_reason = ?
    WHERE ticket_id = ? AND status = 'pendente'
  `),
  upsertMediatorRegistry: db.prepare(`
    INSERT INTO mediator_registry (user_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at
  `),
  mediatorRegistry: db.prepare('SELECT * FROM mediator_registry WHERE user_id = ?'),
  addMediatorHistory: db.prepare(`
    INSERT INTO mediator_history (user_id, action, details, actor_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  mediatorHistory: db.prepare(`
    SELECT * FROM mediator_history
    WHERE user_id = ? AND action NOT IN ('consulta', 'consulta_historico')
    ORDER BY id DESC LIMIT ?
  `),
  lastMediatorHistory: db.prepare(`
    SELECT * FROM mediator_history
    WHERE user_id = ? AND action NOT IN ('consulta', 'consulta_historico')
    ORDER BY id DESC LIMIT 1
  `),
  mediatorWarnings: db.prepare(`
    SELECT COUNT(*) AS total FROM mediator_history
    WHERE user_id = ? AND action = 'advertencia'
  `),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ),
  deleteSetting: db.prepare('DELETE FROM settings WHERE key = ?'),
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const commands = [
  new SlashCommandBuilder()
    .setName('setup-ticket')
    .setDescription('Envia ou recria o painel principal de tickets'),
  new SlashCommandBuilder()
    .setName('ticket-info')
    .setDescription('Mostra as informações do ticket atual'),
  new SlashCommandBuilder()
    .setName('ticket-fechar')
    .setDescription('Fecha o ticket atual'),
  new SlashCommandBuilder()
    .setName('mediador-dados')
    .setDescription('Consulta os dados protegidos de um cadastro de mediador')
    .addUserOption((option) =>
      option
        .setName('usuario')
        .setDescription('Mediador que deseja consultar')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('setup-mediadores')
    .setDescription('Envia ou recria o painel administrativo de mediadores'),
].map((command) => command.toJSON());

function panelEmbed() {
  return new EmbedBuilder()
    .setColor(0x00d4ff)
    .setAuthor({
      name: 'SHADOW TICKETS',
      iconURL: client.user.displayAvatarURL(),
    })
    .setTitle('TICKET SHADOW')
    .setDescription(
      [
        '> Seja bem-vindo(a) ao painel de tickets. Caso precise de algum suporte ou tenha alguma dúvida, abra um ticket selecionando a categoria desejada no menu abaixo.',
        '',
        '↪ **Selecione a opção do ticket de acordo com a sua necessidade.**',
      ].join('\n'),
    )
    .setFooter({ text: 'Shadow Apostas • Atendimento privado e seguro' })
    .setTimestamp();
}

function panelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('open:ticket_type')
        .setPlaceholder('Clique aqui para ver as opções disponíveis')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          {
            label: 'Suporte',
            description: 'Clique aqui caso precise de algum suporte.',
            value: 'suporte',
            emoji: '🛠️',
          },
          {
            label: 'Reembolso',
            description: 'Clique aqui caso precise de algum reembolso.',
            value: 'reembolso',
            emoji: '💰',
          },
          {
            label: 'Receber Evento',
            description: 'Clique aqui para receber um evento.',
            value: 'evento',
            emoji: '🎉',
          },
          {
            label: 'Vagas Mediadores',
            description: 'Clique aqui caso queira uma vaga de mediador.',
            value: 'mediador',
            emoji: '👻',
          },
        ),
    ),
  ];
}

function mediatorsPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('👻 Painel de Mediadores')
    .setDescription('Controle completo dos mediadores da Shadow Apostas.')
    .addFields(
      { name: 'Cargos', value: 'Conceda ou remova o cargo de mediador.', inline: true },
      { name: 'Disciplina', value: 'Aplique advertências, baixas e banimentos.', inline: true },
      { name: 'Consultas', value: 'Consulte dados protegidos e o histórico.', inline: true },
    )
    .setFooter({ text: 'Shadow Apostas • Uso exclusivo da staff' })
    .setTimestamp();
}

function mediatorsPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mediators:give').setLabel('Dar Cargo').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('mediators:remove').setLabel('Tirar Cargo').setEmoji('❌').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mediators:ban').setLabel('Banir Mediador').setEmoji('⛔').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('mediators:leave').setLabel('Dar Baixa').setEmoji('📉').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mediators:notify').setLabel('Notificar').setEmoji('📢').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mediators:warn').setLabel('Advertir').setEmoji('⚠️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('mediators:consult').setLabel('Consultar Mediador').setEmoji('📋').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mediators:history').setLabel('Histórico').setEmoji('🗂️').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function mediatorPanelModal(action, title, detailLabel = null) {
  const modal = new ModalBuilder()
    .setCustomId(`mediator_panel_modal:${action}`)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('member')
          .setLabel('ID ou menção do usuário')
          .setPlaceholder('Ex.: 123456789012345678 ou @pessoa')
          .setStyle(TextInputStyle.Short)
          .setMinLength(17)
          .setMaxLength(25)
          .setRequired(true),
      ),
    );
  if (detailLabel) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('details')
          .setLabel(detailLabel)
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true),
      ),
    );
  }
  return modal;
}

function adminComponents(disabled = false, type = null) {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:claim')
        .setLabel('Assumir Ticket')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('ticket:responsible')
        .setLabel('Transferir Responsável')
        .setEmoji('🔁')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('ticket:sector')
        .setLabel('Transferir Setor')
        .setEmoji('📂')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:add')
        .setLabel('Adicionar Pessoa')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('ticket:remove')
        .setLabel('Remover Pessoa')
        .setEmoji('➖')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('ticket:close')
        .setLabel('Fechar Ticket')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    ),
  ];
  if (type === 'mediador') {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket:mediator_approve')
          .setLabel('Aprovar Mediador')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('ticket:mediator_reject')
          .setLabel('Recusar Mediador')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(disabled),
      ),
    );
  }
  return rows;
}

function ticketEmbed(ticket, openerId) {
  const type = TICKET_TYPES[ticket.type];
  return new EmbedBuilder()
    .setColor(type.color)
    .setTitle(`${type.emoji} Atendimento • ${type.label}`)
    .setDescription(type.description)
    .addFields(
      { name: 'Ticket', value: `#${ticket.id}`, inline: true },
      { name: 'Solicitante', value: `<@${openerId}>`, inline: true },
      {
        name: 'Responsável',
        value: ticket.responsible_id ? `<@${ticket.responsible_id}>` : 'Não definido',
        inline: true,
      },
      { name: 'Status', value: '🟢 Aberto', inline: true },
    )
    .setFooter({ text: 'Use os botões abaixo para administrar este atendimento.' })
    .setTimestamp(new Date(ticket.created_at));
}

function infoEmbed(ticket) {
  const type = TICKET_TYPES[ticket.type] || { label: ticket.type, emoji: '🎫' };
  const status = ticket.status === 'aberto' ? '🟢 Aberto' : '🔴 Fechado';
  return new EmbedBuilder()
    .setColor(ticket.status === 'aberto' ? Colors.Green : Colors.Red)
    .setTitle(`${type.emoji} Informações do Ticket #${ticket.id}`)
    .addFields(
      { name: 'Setor', value: type.label, inline: true },
      { name: 'Status', value: status, inline: true },
      { name: 'Solicitante', value: `<@${ticket.user_id}>`, inline: true },
      {
        name: 'Responsável',
        value: ticket.responsible_id ? `<@${ticket.responsible_id}>` : 'Não definido',
        inline: true,
      },
      {
        name: 'Criado em',
        value: `<t:${Math.floor(new Date(ticket.created_at).getTime() / 1000)}:F>`,
        inline: true,
      },
      {
        name: 'Fechado em',
        value: ticket.closed_at
          ? `<t:${Math.floor(new Date(ticket.closed_at).getTime() / 1000)}:F>`
          : '—',
        inline: true,
      },
    );
}

function cleanThreadName(prefix, username) {
  const clean = username
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 75);
  return `${prefix}-${clean || 'usuario'}`.slice(0, 100);
}

function memberInputModal(action, title, label) {
  return new ModalBuilder()
    .setCustomId(`modal:${action}`)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('member')
          .setLabel(label)
          .setPlaceholder('Ex.: 123456789012345678 ou @pessoa')
          .setStyle(TextInputStyle.Short)
          .setMinLength(17)
          .setMaxLength(25)
          .setRequired(true),
      ),
    );
}

function parseMemberId(value) {
  const match = value.trim().match(/^(?:<@!?)?(\d{17,20})>?$/);
  return match?.[1] || null;
}

function encryptSensitive(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', DATA_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
}

function decryptSensitive(payload) {
  const [ivText, tagText, encryptedText] = payload.split('.');
  if (!ivText || !tagText || !encryptedText) throw new Error('Registro criptografado inválido.');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    DATA_ENCRYPTION_KEY,
    Buffer.from(ivText, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function normalizeCpf(value) {
  const digits = value.replace(/\D/g, '');
  return digits.length === 11 ? digits : null;
}

function maskCpf(cpf) {
  return `***.***.***-${cpf.slice(-2)}`;
}

function maskAddress(address) {
  return address.replace(/[\p{L}\p{N}]+/gu, (part) => {
    if (/^\d+$/u.test(part)) return '*'.repeat(Math.min(part.length, 8));
    if (part.length <= 2) return '*'.repeat(part.length);
    return `${part[0]}${'*'.repeat(Math.min(part.length - 1, 8))}`;
  });
}

function mediatorApplicationModal() {
  return new ModalBuilder()
    .setCustomId('mediator:application')
    .setTitle('Vagas Mediadores')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('real_name')
          .setLabel('Nome real completo')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('cpf')
          .setLabel('CPF')
          .setPlaceholder('000.000.000-00')
          .setStyle(TextInputStyle.Short)
          .setMinLength(11)
          .setMaxLength(14)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('address')
          .setLabel('Endereço completo')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(500)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('age')
          .setLabel('Idade')
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(3)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('experience')
          .setLabel('Experiência como mediador')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true),
      ),
    );
}

function protectedApplicationEmbed(application) {
  return new EmbedBuilder()
    .setColor(0xeb459e)
    .setTitle('👻 Cadastro para Mediador')
    .addFields(
      { name: 'Nome real', value: application.realName },
      { name: 'CPF', value: maskCpf(application.cpf), inline: true },
      { name: 'Idade', value: String(application.age), inline: true },
      { name: 'Endereço', value: 'Endereço cadastrado com segurança' },
      { name: 'Experiência', value: application.experience },
    )
    .setFooter({ text: 'Dados sensíveis protegidos por criptografia.' })
    .setTimestamp();
}

async function renameTicketThread(thread, typeKey, member) {
  const type = TICKET_TYPES[typeKey];
  await thread.setName(
    cleanThreadName(type.prefix, member.user.username),
    `Responsável do ticket alterado para ${member.user.tag}`,
  );
}

async function fetchAllThreadMessages(thread) {
  const messages = [];
  let before;
  while (true) {
    const batch = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return messages.sort((first, second) => first.createdTimestamp - second.createdTimestamp);
}

async function forwardThreadContent(sourceThread, targetThread) {
  const messages = await fetchAllThreadMessages(sourceThread);
  await targetThread.send({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Blurple)
        .setTitle('📨 Histórico encaminhado')
        .setDescription(`Conteúdo transferido de **${sourceThread.name}**.`)
        .setTimestamp(),
    ],
  });

  for (const message of messages) {
    try {
      await message.forward(targetThread);
    } catch {
      const attachmentLinks = [...message.attachments.values()].map((attachment) => attachment.url);
      const embedDescriptions = message.embeds
        .map((embed) => [embed.title, embed.description].filter(Boolean).join(' — '))
        .filter(Boolean);
      const stickerLinks = [...message.stickers.values()].map((sticker) => sticker.url);
      const snapshot = [
        message.content || null,
        ...embedDescriptions,
        ...attachmentLinks,
        ...stickerLinks,
      ]
        .filter(Boolean)
        .join('\n') || '[Mensagem sem conteúdo textual]';
      await targetThread.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x4e5058)
            .setAuthor({
              name: message.author.tag,
              iconURL: message.author.displayAvatarURL(),
            })
            .setDescription(snapshot.slice(0, 4096))
            .setFooter({ text: `Mensagem original • ${message.id}` })
            .setTimestamp(message.createdAt),
        ],
        allowedMentions: { parse: [] },
      });
    }
  }
  return messages.length;
}

function isStaff(member) {
  return Boolean(
    member &&
      (member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.roles.cache.has(config.staffRoleId)),
  );
}

function isMediatorPanelStaff(member) {
  return Boolean(member?.roles.cache.has(config.staffRoleId));
}

const MEDIATOR_ACTION_LABELS = {
  aprovacao: 'Aprovação',
  recusa: 'Recusa de candidatura',
  cargo_adicionado: 'Cargo adicionado',
  cargo_removido: 'Cargo removido',
  banimento: 'Banimento',
  baixa: 'Baixa',
  notificacao: 'Notificação',
  advertencia: 'Advertência',
  consulta: 'Consulta administrativa',
  consulta_historico: 'Consulta de histórico',
};

function saveMediatorAction(userId, action, details, actorId, status = null) {
  const now = new Date().toISOString();
  const operation = db.transaction(() => {
    if (status) queries.upsertMediatorRegistry.run(userId, status, now, now);
    queries.addMediatorHistory.run(userId, action, details || null, actorId, now);
  });
  operation();
  return now;
}

function canViewMediatorData(member) {
  return Boolean(
    member &&
      (member.id === config.ownerUserId || member.roles.cache.has(config.ownerRoleId)),
  );
}

function ticketForInteraction(interaction) {
  return queries.byThread.get(interaction.channelId);
}

async function fetchTextChannel(guild, channelId, label) {
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error(`${label} deve apontar para um canal de texto.`);
  }
  return channel;
}

async function addRoleMembersToThread(guild, thread, roleId) {
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return;
  await guild.members.fetch().catch(() => null);
  const members = role.members.filter((member) => !member.user.bot);
  await Promise.allSettled(members.map((member) => thread.members.add(member.id)));
}

async function addOperationalMembers(guild, thread, type) {
  await addRoleMembersToThread(guild, thread, config.staffRoleId);
  if (type === 'mediador' && config.mediatorRoleId !== config.staffRoleId) {
    await addRoleMembersToThread(guild, thread, config.mediatorRoleId);
  }
}

async function sendLog(guild, embed) {
  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (channel?.isTextBased()) await channel.send({ embeds: [embed] }).catch(() => null);
}

async function sendMediatorLog(guild, embed) {
  const channel = await guild.channels.fetch(config.mediatorsLogChannelId).catch((error) => {
    console.error('LOG_MEDIADORES_CHANNEL_ID não existe ou não está acessível:', error);
    return null;
  });
  if (!channel?.isTextBased()) {
    console.error('LOG_MEDIADORES_CHANNEL_ID não aponta para um canal de texto válido.');
    return;
  }
  await channel.send({ embeds: [embed] }).catch((error) => {
    console.error('Falha ao enviar log de mediadores:', error);
  });
}

async function sendPanel(guild, forceNew = false) {
  const channel = await fetchTextChannel(guild, config.panelChannelId, 'OPEN_TICKET_CHANNEL_ID');
  const saved = queries.getSetting.get('panel_message_id')?.value;

  if (saved && !forceNew) {
    const existing = await channel.messages.fetch(saved).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [panelEmbed()], components: panelComponents() });
      return existing;
    }
  }

  if (saved && forceNew) {
    const old = await channel.messages.fetch(saved).catch(() => null);
    if (old) await old.delete().catch(() => null);
  }

  const message = await channel.send({ embeds: [panelEmbed()], components: panelComponents() });
  await message.pin().catch(() => null);
  queries.setSetting.run('panel_message_id', message.id);
  return message;
}

async function sendMediatorsPanel(guild, forceNew = false) {
  const channel = await fetchTextChannel(
    guild,
    config.mediatorsPanelChannelId,
    'MEDIADORES_PANEL_CHANNEL_ID',
  );
  const saved = queries.getSetting.get('mediators_panel_message_id')?.value;
  if (saved && !forceNew) {
    const existing = await channel.messages.fetch(saved).catch(() => null);
    if (existing) {
      await existing.edit({
        embeds: [mediatorsPanelEmbed()],
        components: mediatorsPanelComponents(),
      });
      return existing;
    }
  }
  if (saved && forceNew) {
    const old = await channel.messages.fetch(saved).catch(() => null);
    if (old) await old.delete().catch(() => null);
  }
  const message = await channel.send({
    embeds: [mediatorsPanelEmbed()],
    components: mediatorsPanelComponents(),
  });
  await message.pin().catch(() => null);
  queries.setSetting.run('mediators_panel_message_id', message.id);
  return message;
}

async function createTicket(interaction, typeKey, mediatorApplication = null) {
  const type = TICKET_TYPES[typeKey];
  if (!type) return;

  await interaction.deferReply({ ephemeral: true });
  const existing = queries.openByUserType.get(interaction.user.id, typeKey);
  if (existing) {
    const oldThread = await interaction.guild.channels.fetch(existing.thread_id).catch(() => null);
    if (oldThread) {
      await interaction.editReply(`Você já possui um ticket aberto neste setor: <#${existing.thread_id}>`);
      return;
    }
    queries.close.run(new Date().toISOString(), existing.id);
  }

  const parent = await fetchTextChannel(interaction.guild, type.channelId, `${typeKey.toUpperCase()}_CHANNEL_ID`);
  const thread = await parent.threads.create({
    name: cleanThreadName(type.prefix, interaction.user.username),
    autoArchiveDuration: 1440,
    type: ChannelType.PrivateThread,
    invitable: false,
    reason: `Ticket ${type.label} aberto por ${interaction.user.tag}`,
  });

  const result = queries.createTicket.run(
    thread.id,
    interaction.user.id,
    typeKey,
    new Date().toISOString(),
  );
  const ticket = queries.byThread.get(thread.id);

  try {
    await thread.members.add(interaction.user.id);
    await addOperationalMembers(interaction.guild, thread, typeKey);
    if (typeKey === 'mediador' && mediatorApplication) {
      queries.createMediatorApplication.run(
        ticket.id,
        interaction.user.id,
        mediatorApplication.realName,
        encryptSensitive(mediatorApplication.cpf),
        encryptSensitive(mediatorApplication.address),
        mediatorApplication.age,
        mediatorApplication.experience,
        ticket.created_at,
      );
    }
    await thread.send({
      content: `<@${interaction.user.id}> <@&${config.staffRoleId}>`,
      allowedMentions: { users: [interaction.user.id], roles: [config.staffRoleId] },
      embeds: [
        ticketEmbed(ticket, interaction.user.id),
        ...(mediatorApplication ? [protectedApplicationEmbed(mediatorApplication)] : []),
      ],
      components: adminComponents(false, typeKey),
    });
  } catch (error) {
    queries.close.run(new Date().toISOString(), result.lastInsertRowid);
    await thread.delete('Falha ao preparar o ticket').catch(() => null);
    throw error;
  }

  await sendLog(
    interaction.guild,
    new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle('🎫 Ticket aberto')
      .addFields(
        { name: 'Ticket', value: `#${ticket.id}`, inline: true },
        { name: 'Setor', value: type.label, inline: true },
        { name: 'Solicitante', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Tópico', value: `<#${thread.id}>` },
      )
      .setTimestamp(),
  );
  await interaction.editReply(`Seu atendimento foi criado: <#${thread.id}>`);
}

async function handleMediatorApplication(interaction) {
  const cpf = normalizeCpf(interaction.fields.getTextInputValue('cpf'));
  const age = Number.parseInt(interaction.fields.getTextInputValue('age').trim(), 10);
  if (!cpf) {
    await interaction.reply({ content: 'Informe um CPF válido com 11 dígitos.', ephemeral: true });
    return;
  }
  if (!Number.isInteger(age) || age < 1 || age > 120) {
    await interaction.reply({ content: 'Informe uma idade válida.', ephemeral: true });
    return;
  }

  await createTicket(interaction, 'mediador', {
    realName: interaction.fields.getTextInputValue('real_name').trim(),
    cpf,
    address: interaction.fields.getTextInputValue('address').trim(),
    age,
    experience: interaction.fields.getTextInputValue('experience').trim(),
  });
}

async function closeTicket(interaction, ticket) {
  if (ticket.status === 'fechado') {
    await interaction.reply({ content: 'Este ticket já está fechado.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const closedAt = new Date().toISOString();
  queries.close.run(closedAt, ticket.id);

  const type = TICKET_TYPES[ticket.type];
  const createdTimestamp = Math.floor(new Date(ticket.created_at).getTime() / 1000);
  const closedTimestamp = Math.floor(new Date(closedAt).getTime() / 1000);
  const summary = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle(`🔒 Resumo final • Ticket #${ticket.id}`)
    .addFields(
      { name: 'Setor', value: `${type.emoji} ${type.label}`, inline: true },
      { name: 'Solicitante', value: `<@${ticket.user_id}>`, inline: true },
      {
        name: 'Responsável',
        value: ticket.responsible_id ? `<@${ticket.responsible_id}>` : 'Não definido',
        inline: true,
      },
      { name: 'Aberto em', value: `<t:${createdTimestamp}:F>`, inline: true },
      { name: 'Fechado em', value: `<t:${closedTimestamp}:F>`, inline: true },
      { name: 'Fechado por', value: `<@${interaction.user.id}>`, inline: true },
    )
    .setFooter({ text: 'Shadow Tickets • Atendimento encerrado' })
    .setTimestamp();

  await interaction.channel.send({
    embeds: [summary],
  });
  await sendLog(
    interaction.guild,
    new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle('🔒 Ticket fechado')
      .addFields(
        { name: 'Ticket', value: `#${ticket.id}`, inline: true },
        { name: 'Encerrado por', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Solicitante', value: `<@${ticket.user_id}>`, inline: true },
      )
      .setTimestamp(),
  );
  await interaction.editReply('Ticket fechado. Este tópico será excluído.');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await interaction.channel.delete(`Ticket #${ticket.id} fechado por ${interaction.user.tag}`);
}

async function requireStaff(interaction) {
  if (isStaff(interaction.member)) return true;
  await interaction.reply({
    content: 'Apenas a equipe de staff pode usar este controle.',
    ephemeral: true,
  });
  return false;
}

async function approveMediator(interaction, ticket) {
  const application = queries.mediatorByTicket.get(ticket.id);
  if (!application || application.status !== 'pendente') {
    await interaction.reply({ content: 'Este cadastro já foi analisado ou não existe.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild;
  const member = await guild.members.fetch(ticket.user_id).catch(() => null);
  const botMember = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  const mediatorRole = await guild.roles.fetch(config.mediatorRoleId).catch(() => null);

  if (!member || !botMember || !mediatorRole) {
    await interaction.editReply('Não foi possível localizar o usuário, o bot ou o cargo de mediador.');
    return;
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
      botMember.roles.highest.comparePositionTo(mediatorRole) <= 0) {
    await interaction.editReply('Não posso adicionar o cargo de mediador. Verifique a permissão e a hierarquia de cargos.');
    return;
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageNicknames)) {
    await interaction.editReply('Não tenho permissão para alterar apelidos. Conceda a permissão Gerenciar Apelidos.');
    return;
  }
  if (!member.manageable || member.id === guild.ownerId) {
    await interaction.editReply('Não posso alterar o apelido: o usuário está acima do bot na hierarquia ou é o dono do servidor.');
    return;
  }

  await member.roles.add(mediatorRole, `Mediador aprovado por ${interaction.user.tag}`);
  try {
    await member.setNickname(
      `ADM | ${application.real_name}`.slice(0, 32),
      `Mediador aprovado por ${interaction.user.tag}`,
    );
  } catch (error) {
    await member.roles.remove(mediatorRole, 'Reversão: não foi possível alterar o apelido').catch(() => null);
    console.error('Falha ao alterar apelido do mediador:', error);
    await interaction.editReply('Não foi possível alterar o apelido. Verifique a permissão e a posição do usuário na hierarquia.');
    return;
  }

  const reviewedAt = new Date().toISOString();
  queries.approveMediator.run(interaction.user.id, reviewedAt, ticket.id);
  saveMediatorAction(ticket.user_id, 'aprovacao', null, interaction.user.id, 'Aprovado');
  const cpf = decryptSensitive(application.cpf_encrypted);
  const address = decryptSensitive(application.address_encrypted);
  const controlEmbed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle('✅ Mediador aprovado')
    .addFields(
      { name: 'Usuário Discord', value: `<@${ticket.user_id}>`, inline: true },
      { name: 'ID Discord', value: ticket.user_id, inline: true },
      { name: 'Nome real', value: application.real_name },
      { name: 'CPF', value: maskCpf(cpf), inline: true },
      { name: 'Endereço', value: maskAddress(address) },
      { name: 'Status', value: 'Aprovado', inline: true },
      { name: 'Aprovado por', value: `<@${interaction.user.id}>`, inline: true },
      {
        name: 'Data de aprovação',
        value: `<t:${Math.floor(new Date(reviewedAt).getTime() / 1000)}:F>`,
      },
      {
        name: 'Observação',
        value: 'Dados completos protegidos no banco criptografado.',
      },
    )
    .setTimestamp();

  const controlChannel = await guild.channels
    .fetch(config.registeredMediatorsChannelId)
    .catch((error) => {
      console.error('MEDIADORES_CADASTRADOS_CHANNEL_ID não existe ou não está acessível:', error);
      return null;
    });
  if (!controlChannel?.isTextBased()) {
    console.error('MEDIADORES_CADASTRADOS_CHANNEL_ID não aponta para um canal de texto válido.');
  } else {
    await controlChannel.send({ embeds: [controlEmbed] }).catch((error) => {
      console.error('Falha ao enviar o controle do mediador aprovado:', error);
    });
  }

  await interaction.channel.send({
    content: `✅ <@${ticket.user_id}> foi aprovado como mediador por <@${interaction.user.id}>.`,
    allowedMentions: { users: [ticket.user_id, interaction.user.id] },
  });
  await sendMediatorLog(
    guild,
    mediatorActionLog('✅ Mediador aprovado', Colors.Green, ticket.user_id, interaction.user.id),
  );
  await interaction.editReply('Mediador aprovado com sucesso.');
}

async function refuseMediator(interaction, ticket) {
  const application = queries.mediatorByTicket.get(ticket.id);
  if (!application || application.status !== 'pendente') {
    await interaction.reply({ content: 'Este cadastro já foi analisado ou não existe.', ephemeral: true });
    return;
  }
  const reason = interaction.fields.getTextInputValue('reason').trim();
  queries.refuseMediator.run(interaction.user.id, new Date().toISOString(), reason, ticket.id);
  saveMediatorAction(ticket.user_id, 'recusa', reason, interaction.user.id, 'Recusado');
  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle('❌ Candidatura recusada')
        .setDescription(reason)
        .addFields({ name: 'Analisado por', value: `<@${interaction.user.id}>` })
        .setTimestamp(),
      ],
  });
  await sendMediatorLog(
    interaction.guild,
    mediatorActionLog('❌ Candidatura de mediador recusada', Colors.Red, ticket.user_id, interaction.user.id, reason),
  );
  await closeTicket(interaction, ticket);
}

async function handleAdminButton(interaction) {
  if (!(await requireStaff(interaction))) return;
  const ticket = ticketForInteraction(interaction);
  if (!ticket || ticket.status !== 'aberto') {
    await interaction.reply({ content: 'Este não é um ticket aberto.', ephemeral: true });
    return;
  }

  const action = interaction.customId.split(':')[1];
  if (action === 'mediator_approve') {
    if (ticket.type !== 'mediador') {
      await interaction.reply({ content: 'Este controle só pode ser usado em vagas de mediadores.', ephemeral: true });
      return;
    }
    await approveMediator(interaction, ticket);
    return;
  }

  if (action === 'mediator_reject') {
    if (ticket.type !== 'mediador') {
      await interaction.reply({ content: 'Este controle só pode ser usado em vagas de mediadores.', ephemeral: true });
      return;
    }
    const application = queries.mediatorByTicket.get(ticket.id);
    if (!application || application.status !== 'pendente') {
      await interaction.reply({ content: 'Este cadastro já foi analisado ou não existe.', ephemeral: true });
      return;
    }
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId('mediator:reject')
        .setTitle('Recusar Mediador')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('reason')
              .setLabel('Motivo da recusa')
              .setStyle(TextInputStyle.Paragraph)
              .setMaxLength(1000)
              .setRequired(true),
          ),
        ),
    );
    return;
  }

  if (action === 'claim') {
    const staffMember = await interaction.guild.members.fetch(interaction.user.id);
    queries.assume.run(interaction.user.id, ticket.id);
    await renameTicketThread(interaction.channel, ticket.type, staffMember);
    await interaction.reply({
      content: `✅ Ticket assumido por <@${interaction.user.id}>.`,
      allowedMentions: { users: [interaction.user.id] },
    });
    return;
  }

  if (action === 'responsible') {
    await interaction.showModal(
      memberInputModal('responsible', 'Transferir responsável', 'ID ou menção do novo responsável'),
    );
    return;
  }

  if (action === 'sector') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('select:sector')
      .setPlaceholder('Selecione o novo setor')
      .addOptions(
        Object.entries(TICKET_TYPES).map(([value, type]) => ({
          label: type.label,
          value,
          emoji: type.emoji,
          default: value === ticket.type,
        })),
      );
    await interaction.reply({
      content: 'Selecione o setor de destino:',
      components: [new ActionRowBuilder().addComponents(menu)],
      ephemeral: true,
    });
    return;
  }

  if (action === 'add' || action === 'remove') {
    await interaction.showModal(
      memberInputModal(
        action,
        action === 'add' ? 'Adicionar pessoa' : 'Remover pessoa',
        'ID ou menção da pessoa',
      ),
    );
    return;
  }

  if (action === 'close') {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle('🔒 Confirmar fechamento')
          .setDescription('Tem certeza de que deseja fechar e excluir permanentemente este tópico?'),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('ticket:close_confirm')
            .setLabel('Confirmar fechamento')
            .setEmoji('🔒')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('ticket:close_cancel')
            .setLabel('Cancelar')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  if (action === 'close_confirm') return await closeTicket(interaction, ticket);
  if (action === 'close_cancel') {
    await interaction.update({ content: 'Fechamento cancelado.', embeds: [], components: [] });
  }
}

async function handleMemberModal(interaction) {
  if (!(await requireStaff(interaction))) return;
  const ticket = ticketForInteraction(interaction);
  if (!ticket || ticket.status !== 'aberto') {
    await interaction.reply({ content: 'Este não é um ticket aberto.', ephemeral: true });
    return;
  }

  const action = interaction.customId.split(':')[1];
  const userId = parseMemberId(interaction.fields.getTextInputValue('member'));
  if (!userId) {
    await interaction.reply({ content: 'Informe um ID ou uma menção válida.', ephemeral: true });
    return;
  }
  const selectedMember = await interaction.guild.members.fetch(userId).catch(() => null);
  if (!selectedMember || selectedMember.user.bot) {
    await interaction.reply({ content: 'Selecione um membro válido.', ephemeral: true });
    return;
  }

  if (action === 'responsible') {
    if (!isStaff(selectedMember)) {
      await interaction.reply({ content: 'O responsável precisa pertencer à equipe de staff.', ephemeral: true });
      return;
    }
    await interaction.channel.members.add(userId).catch(() => null);
    queries.assume.run(userId, ticket.id);
    await renameTicketThread(interaction.channel, ticket.type, selectedMember);
    await interaction.reply({ content: 'Responsável atualizado.', ephemeral: true });
    const oldResponsible = ticket.responsible_id ? `<@${ticket.responsible_id}>` : '**não definido**';
    await interaction.channel.send({
      content: `🔁 Responsabilidade transferida de ${oldResponsible} para <@${userId}>.`,
      allowedMentions: {
        users: [ticket.responsible_id, userId].filter(Boolean),
      },
    });
    return;
  }

  if (action === 'add') {
    await interaction.channel.members.add(userId);
    queries.addMember.run(ticket.id, userId);
    await interaction.reply({ content: 'Pessoa adicionada ao ticket.', ephemeral: true });
    await interaction.channel.send({
      content: `➕ <@${userId}> foi adicionado ao ticket por <@${interaction.user.id}>.`,
      allowedMentions: { users: [userId, interaction.user.id] },
    });
    return;
  }

  if (action === 'remove') {
    if (userId === ticket.user_id || isStaff(selectedMember)) {
      await interaction.reply({
        content: 'O solicitante e membros da staff não podem ser removidos por este controle.',
        ephemeral: true,
      });
      return;
    }
    await interaction.channel.members.remove(userId).catch(() => null);
    queries.removeMember.run(ticket.id, userId);
    await interaction.reply({ content: 'Pessoa removida do ticket.', ephemeral: true });
    await interaction.channel.send({
      content: `➖ <@${userId}> foi removido do ticket por <@${interaction.user.id}>.`,
      allowedMentions: { users: [userId, interaction.user.id] },
    });
  }
}

async function handleSectorSelect(interaction) {
  if (!(await requireStaff(interaction))) return;
  const ticket = ticketForInteraction(interaction);
  if (!ticket || ticket.status !== 'aberto') {
    await interaction.reply({ content: 'Este não é um ticket aberto.', ephemeral: true });
    return;
  }

  const targetKey = interaction.values[0];
  const target = TICKET_TYPES[targetKey];
  if (!target || targetKey === ticket.type) {
    await interaction.update({ content: 'O ticket já pertence a esse setor.', components: [] });
    return;
  }

  await interaction.deferUpdate();
  const parent = await fetchTextChannel(interaction.guild, target.channelId, `${targetKey.toUpperCase()}_CHANNEL_ID`);
  const opener = await interaction.guild.members.fetch(ticket.user_id).catch(() => null);
  const responsible = ticket.responsible_id
    ? await interaction.guild.members.fetch(ticket.responsible_id).catch(() => null)
    : null;
  const newThread = await parent.threads.create({
    name: cleanThreadName(
      target.prefix,
      responsible?.user.username || opener?.user.username || `ticket-${ticket.id}`,
    ),
    autoArchiveDuration: 1440,
    type: ChannelType.PrivateThread,
    invitable: false,
    reason: `Transferência do ticket #${ticket.id}`,
  });

  await newThread.members.add(ticket.user_id);
  await addOperationalMembers(interaction.guild, newThread, targetKey);
  const extraMembers = queries.members.all(ticket.id);
  await Promise.allSettled(extraMembers.map(({ user_id: id }) => newThread.members.add(id)));
  if (ticket.responsible_id) await newThread.members.add(ticket.responsible_id).catch(() => null);

  await interaction.editReply({
    content: `Transferindo todo o histórico para <#${newThread.id}>...`,
    components: [],
  });

  let copiedMessages;
  try {
    copiedMessages = await forwardThreadContent(interaction.channel, newThread);
    const updated = { ...ticket, thread_id: newThread.id, type: targetKey };
    const mediatorRecord = queries.mediatorByTicket.get(ticket.id);
    const protectedRecordEmbed = mediatorRecord
      ? protectedApplicationEmbed({
          realName: mediatorRecord.real_name,
          cpf: decryptSensitive(mediatorRecord.cpf_encrypted),
          age: mediatorRecord.age,
          experience: mediatorRecord.experience,
        })
      : null;
    const mentionedUsers = [ticket.user_id, ticket.responsible_id].filter(Boolean);
    await newThread.send({
      content: [
        `<@${ticket.user_id}>`,
        ticket.responsible_id ? `<@${ticket.responsible_id}>` : null,
        `<@&${config.staffRoleId}>`,
      ]
        .filter(Boolean)
        .join(' '),
      allowedMentions: { users: mentionedUsers, roles: [config.staffRoleId] },
      embeds: [ticketEmbed(updated, ticket.user_id), ...(protectedRecordEmbed ? [protectedRecordEmbed] : [])],
      components: adminComponents(false, targetKey === 'mediador' && mediatorRecord ? 'mediador' : null),
    });
    await newThread.send(
      `📂 Ticket transferido de **${TICKET_TYPES[ticket.type].label}** para **${target.label}** por <@${interaction.user.id}>.`,
    );
  } catch (error) {
    await newThread.delete('Falha ao copiar integralmente o ticket').catch(() => null);
    throw error;
  }

  queries.transferThread.run(newThread.id, targetKey, ticket.id);
  await interaction.editReply({
    content: `Ticket transferido para <#${newThread.id}> com ${copiedMessages} mensagens encaminhadas.`,
    components: [],
  });
  await interaction.channel.send(`📂 Este atendimento foi transferido para <#${newThread.id}> e será excluído.`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await interaction.channel.delete(`Ticket #${ticket.id} transferido para ${target.label}`);
}

async function handleMediatorsPanelButton(interaction) {
  if (!isMediatorPanelStaff(interaction.member)) {
    await interaction.reply({ content: 'Apenas membros do cargo de staff podem usar este painel.', ephemeral: true });
    return;
  }
  const action = interaction.customId.split(':')[1];
  const definitions = {
    give: ['Dar Cargo de Mediador', null],
    remove: ['Tirar Cargo de Mediador', null],
    ban: ['Banir Mediador', 'Motivo do banimento'],
    leave: ['Dar Baixa no Mediador', 'Motivo da baixa'],
    notify: ['Notificar Mediador', 'Mensagem da notificação'],
    warn: ['Advertir Mediador', 'Motivo da advertência'],
    consult: ['Consultar Mediador', null],
    history: ['Histórico do Mediador', null],
  };
  const definition = definitions[action];
  if (!definition) return;
  await interaction.showModal(mediatorPanelModal(action, definition[0], definition[1]));
}

async function mediatorRoleContext(guild, member) {
  const botMember = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  const role = await guild.roles.fetch(config.mediatorRoleId).catch(() => null);
  if (!botMember || !role) return { error: 'Não foi possível localizar o bot ou o cargo de mediador.' };
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { error: 'O bot não possui a permissão Gerenciar Cargos.' };
  }
  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    return { error: 'O cargo de mediador está acima ou na mesma posição do cargo do bot.' };
  }
  if (member.id === guild.ownerId || botMember.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    return { error: 'O usuário está acima do bot na hierarquia e não pode ser gerenciado.' };
  }
  return { botMember, role };
}

function mediatorActionLog(title, color, targetId, actorId, details = null) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .addFields(
      { name: 'Mediador', value: `<@${targetId}> (${targetId})` },
      { name: 'Executado por', value: `<@${actorId}>` },
    )
    .setTimestamp();
  if (details) embed.addFields({ name: 'Detalhes', value: details.slice(0, 1024) });
  return embed;
}

async function handleMediatorsPanelModal(interaction) {
  if (!isMediatorPanelStaff(interaction.member)) {
    await interaction.reply({ content: 'Apenas membros do cargo de staff podem usar este painel.', ephemeral: true });
    return;
  }
  const action = interaction.customId.split(':')[1];
  const userId = parseMemberId(interaction.fields.getTextInputValue('member'));
  if (!userId) {
    await interaction.reply({ content: 'Informe um ID ou uma menção válida.', ephemeral: true });
    return;
  }
  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  const allowsFormerMember = action === 'consult' || action === 'history';
  const targetUser = member?.user ||
    (allowsFormerMember ? await interaction.client.users.fetch(userId).catch(() => null) : null);
  if (!targetUser || targetUser.bot || (!member && !allowsFormerMember)) {
    await interaction.reply({ content: 'O usuário não existe no servidor ou não pode ser gerenciado.', ephemeral: true });
    return;
  }
  const details = ['ban', 'leave', 'notify', 'warn'].includes(action)
    ? interaction.fields.getTextInputValue('details').trim()
    : null;

  if (action === 'give' || action === 'remove' || action === 'leave' || action === 'ban') {
    const context = await mediatorRoleContext(interaction.guild, member);
    if (context.error) {
      await interaction.reply({ content: context.error, ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });

    if (action === 'give') {
      await member.roles.add(context.role, `Cargo concedido por ${interaction.user.tag}`);
      saveMediatorAction(userId, 'cargo_adicionado', null, interaction.user.id, 'Ativo');
      await sendMediatorLog(
        interaction.guild,
        mediatorActionLog('✅ Cargo de mediador concedido', Colors.Green, userId, interaction.user.id),
      );
      await interaction.editReply('Cargo de mediador concedido e ação registrada.');
      return;
    }

    if (action === 'remove') {
      await member.roles.remove(context.role, `Cargo removido por ${interaction.user.tag}`);
      saveMediatorAction(userId, 'cargo_removido', null, interaction.user.id, 'Sem cargo');
      await sendMediatorLog(
        interaction.guild,
        mediatorActionLog('❌ Cargo de mediador removido', Colors.Orange, userId, interaction.user.id),
      );
      await interaction.editReply('Cargo de mediador removido e ação registrada.');
      return;
    }

    if (action === 'leave') {
      await member.roles.remove(context.role, `Baixa aplicada por ${interaction.user.tag}`);
      saveMediatorAction(userId, 'baixa', details, interaction.user.id, 'Baixado');
      await sendMediatorLog(
        interaction.guild,
        mediatorActionLog('📉 Mediador baixado', Colors.Orange, userId, interaction.user.id, details),
      );
      await interaction.editReply('Baixa registrada e cargo de mediador removido.');
      return;
    }

    if (!member.bannable || !context.botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
      await interaction.editReply('Não foi possível banir: verifique a permissão Banir Membros e a hierarquia do bot.');
      return;
    }
    await member.roles.remove(context.role, `Banimento aplicado por ${interaction.user.tag}`);
    await member.ban({ reason: `${details} | Por ${interaction.user.tag}`.slice(0, 512) });
    saveMediatorAction(userId, 'banimento', details, interaction.user.id, 'Banido');
    await sendMediatorLog(
      interaction.guild,
      mediatorActionLog('⛔ Mediador banido', Colors.Red, userId, interaction.user.id, details),
    );
    await interaction.editReply('Mediador banido e ação registrada.');
    return;
  }

  if (action === 'notify' || action === 'warn') {
    await interaction.deferReply({ ephemeral: true });
    const isWarning = action === 'warn';
    const dmEmbed = new EmbedBuilder()
      .setColor(isWarning ? Colors.Orange : Colors.Blue)
      .setTitle(isWarning ? '⚠️ Advertência da Shadow Apostas' : '📢 Notificação da Shadow Apostas')
      .setDescription(details)
      .setTimestamp();
    const dmSent = await member.send({ embeds: [dmEmbed] }).then(() => true).catch(() => false);
    const historyAction = isWarning ? 'advertencia' : 'notificacao';
    saveMediatorAction(userId, historyAction, details, interaction.user.id);
    const totalWarnings = queries.mediatorWarnings.get(userId).total;
    await sendMediatorLog(
      interaction.guild,
      mediatorActionLog(
        isWarning ? `⚠️ Advertência aplicada • Total: ${totalWarnings}` : '📢 Mediador notificado',
        isWarning ? Colors.Orange : Colors.Blue,
        userId,
        interaction.user.id,
        `${details}\n\nDM: ${dmSent ? 'entregue' : 'não entregue'}`,
      ),
    );
    await interaction.editReply(
      `${isWarning ? `Advertência registrada. Total: ${totalWarnings}.` : 'Notificação registrada.'} DM ${dmSent ? 'enviada' : 'não pôde ser entregue'}.`,
    );
    return;
  }

  if (action === 'consult') {
    const application = queries.mediatorByUser.get(userId);
    const registry = queries.mediatorRegistry.get(userId);
    const lastAction = queries.lastMediatorHistory.get(userId);
    const totalWarnings = queries.mediatorWarnings.get(userId).total;
    const cpfMasked = application
      ? maskCpf(decryptSensitive(application.cpf_encrypted))
      : 'Não cadastrado';
    const status = registry?.status || (application
      ? application.status === 'aprovado'
        ? 'Aprovado'
        : application.status === 'recusado'
          ? 'Recusado'
          : 'Pendente'
      : 'Não cadastrado');
    const registeredAt = application?.registered_at || registry?.created_at;
    const lastActionText = lastAction
      ? `${MEDIATOR_ACTION_LABELS[lastAction.action] || lastAction.action} • <t:${Math.floor(new Date(lastAction.created_at).getTime() / 1000)}:R>`
      : 'Nenhuma ação registrada';
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x2b2d31)
          .setTitle('📋 Consulta de Mediador')
          .addFields(
            { name: 'Usuário', value: `<@${userId}> (${userId})` },
            { name: 'Nome real', value: application?.real_name || 'Não cadastrado', inline: true },
            { name: 'CPF', value: cpfMasked, inline: true },
            { name: 'Status', value: status, inline: true },
            {
              name: 'Cargo atual',
              value: member?.roles.cache.has(config.mediatorRoleId) ? '✅ Possui' : '❌ Não possui',
              inline: true,
            },
            { name: 'Total de advertências', value: String(totalWarnings), inline: true },
            {
              name: 'Data de cadastro',
              value: registeredAt ? `<t:${Math.floor(new Date(registeredAt).getTime() / 1000)}:F>` : 'Não cadastrada',
            },
            { name: 'Última ação registrada', value: lastActionText },
          )
          .setFooter({ text: 'Dados sensíveis permanecem protegidos.' })
          .setTimestamp(),
      ],
      ephemeral: true,
    });
    saveMediatorAction(userId, 'consulta', null, interaction.user.id);
    await sendMediatorLog(
      interaction.guild,
      mediatorActionLog('📋 Mediador consultado', Colors.Blue, userId, interaction.user.id),
    );
    return;
  }

  if (action === 'history') {
    const history = queries.mediatorHistory.all(userId, 10);
    const lines = history.length
      ? history.map((entry) => {
          const label = MEDIATOR_ACTION_LABELS[entry.action] || entry.action;
          const detail = entry.details ? ` — ${entry.details.replace(/\s+/g, ' ').slice(0, 180)}` : '';
          const timestamp = Math.floor(new Date(entry.created_at).getTime() / 1000);
          return `• **${label}** por <@${entry.actor_id}> <t:${timestamp}:R>${detail}`;
        }).join('\n')
      : 'Nenhuma ação registrada.';
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x2b2d31)
          .setTitle('🗂️ Histórico do Mediador')
          .setDescription(lines.slice(0, 4096))
          .addFields({ name: 'Usuário', value: `<@${userId}> (${userId})` })
          .setFooter({ text: 'Últimas 10 ações registradas' })
          .setTimestamp(),
      ],
      ephemeral: true,
    });
    saveMediatorAction(userId, 'consulta_historico', null, interaction.user.id);
    await sendMediatorLog(
      interaction.guild,
      mediatorActionLog('🗂️ Histórico consultado', Colors.Blue, userId, interaction.user.id),
    );
  }
}

async function handleCommand(interaction) {
  if (interaction.commandName === 'setup-mediadores') {
    if (!isMediatorPanelStaff(interaction.member)) {
      await interaction.reply({ content: 'Apenas membros do cargo de staff podem executar este comando.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const panel = await sendMediatorsPanel(interaction.guild, true);
    await interaction.editReply(`Painel de mediadores publicado em <#${panel.channelId}>.`);
    return;
  }

  if (interaction.commandName === 'setup-ticket') {
    if (!isStaff(interaction.member)) {
      await interaction.reply({ content: 'Apenas a equipe de staff pode executar este comando.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const panel = await sendPanel(interaction.guild, true);
    await interaction.editReply(`Painel publicado em <#${panel.channelId}>.`);
    return;
  }

  if (interaction.commandName === 'mediador-dados') {
    if (!canViewMediatorData(interaction.member)) {
      await interaction.reply({
        content: 'Apenas o cargo de owner ou o dono configurado pode consultar dados protegidos.',
        ephemeral: true,
      });
      return;
    }
    const user = interaction.options.getUser('usuario', true);
    const application = queries.mediatorByUser.get(user.id);
    if (!application) {
      await interaction.reply({ content: 'Nenhum cadastro foi encontrado para esse usuário.', ephemeral: true });
      return;
    }
    const registeredTimestamp = Math.floor(new Date(application.registered_at).getTime() / 1000);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x2b2d31)
          .setTitle('🔐 Dados protegidos do mediador')
          .setDescription('Resposta administrativa privada. Não compartilhe estes dados.')
          .addFields(
            { name: 'Usuário', value: `<@${user.id}> (${user.id})` },
            { name: 'Nome real', value: application.real_name },
            { name: 'CPF completo', value: decryptSensitive(application.cpf_encrypted) },
            { name: 'Endereço completo', value: decryptSensitive(application.address_encrypted) },
            { name: 'Data de cadastro', value: `<t:${registeredTimestamp}:F>` },
            {
              name: 'Quem aprovou',
              value:
                application.status === 'aprovado' && application.reviewed_by
                  ? `<@${application.reviewed_by}>`
                  : 'Ainda não aprovado',
            },
          )
          .setFooter({ text: 'Conteúdo sensível • Uso administrativo' })
          .setTimestamp(),
      ],
      ephemeral: true,
    });
    return;
  }

  const ticket = ticketForInteraction(interaction);
  if (!ticket) {
    await interaction.reply({ content: 'Use este comando dentro de um tópico de ticket.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'ticket-info') {
    await interaction.reply({ embeds: [infoEmbed(ticket)], ephemeral: true });
    return;
  }

  if (interaction.commandName === 'ticket-fechar') {
    const canClose = interaction.user.id === ticket.user_id || isStaff(interaction.member);
    if (!canClose) {
      await interaction.reply({ content: 'Apenas o solicitante ou a staff pode fechar este ticket.', ephemeral: true });
      return;
    }
    await closeTicket(interaction, ticket);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  try {
    const rest = new REST({ version: '10' }).setToken(config.token);
    await rest.put(Routes.applicationGuildCommands(readyClient.user.id, config.guildId), {
      body: commands,
    });
    const guild = await readyClient.guilds.fetch(config.guildId);
    await sendPanel(guild);
    await sendMediatorsPanel(guild);
    console.log(`Shadow Tickets online como ${readyClient.user.tag}.`);
  } catch (error) {
    console.error('Falha na inicialização:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.inGuild() || interaction.guildId !== config.guildId) return;
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('open:')) {
      const type = interaction.customId.split(':')[1];
      if (type === 'mediador') return await interaction.showModal(mediatorApplicationModal());
      return await createTicket(interaction, type);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'open:ticket_type') {
      const type = interaction.values[0];
      if (type === 'mediador') return await interaction.showModal(mediatorApplicationModal());
      return await createTicket(interaction, type);
    }
    if (interaction.isButton() && interaction.customId.startsWith('mediators:')) {
      return await handleMediatorsPanelButton(interaction);
    }
    if (interaction.isButton() && interaction.customId.startsWith('ticket:')) {
      return await handleAdminButton(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal:')) {
      return await handleMemberModal(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('mediator_panel_modal:')) {
      return await handleMediatorsPanelModal(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'mediator:application') {
      return await handleMediatorApplication(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'mediator:reject') {
      if (!(await requireStaff(interaction))) return;
      const ticket = ticketForInteraction(interaction);
      if (!ticket || ticket.type !== 'mediador' || ticket.status !== 'aberto') {
        return await interaction.reply({ content: 'Este não é um ticket de mediador aberto.', ephemeral: true });
      }
      return await refuseMediator(interaction, ticket);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'select:sector') {
      return await handleSectorSelect(interaction);
    }
  } catch (error) {
    console.error('Erro ao processar interação:', error);
    const payload = { content: 'Não foi possível concluir esta ação. Verifique as permissões e tente novamente.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => null);
    else await interaction.reply(payload).catch(() => null);
  }
});

process.on('unhandledRejection', (error) => console.error('Erro não tratado:', error));
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Encerrando Shadow Tickets com ${signal}...`);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (error) {
    console.error('Falha ao encerrar o banco com segurança:', error);
  }
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.token);
