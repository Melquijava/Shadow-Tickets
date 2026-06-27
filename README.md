# Shadow Tickets

Bot de tickets privados por tópicos para o servidor Shadow Apostas.

## Requisitos

- Node.js 18 ou superior
- Intent privilegiada **Server Members Intent** habilitada no Discord Developer Portal
- Permissões do bot: Ver canais, Enviar mensagens, Criar tópicos privados, Enviar mensagens em tópicos, Gerenciar tópicos, Gerenciar mensagens e Usar comandos de aplicativo
- O cargo do bot deve ficar acima dos cargos operacionais na hierarquia do servidor

## Instalação

1. Execute `npm install`.
2. Preencha todas as variáveis do arquivo `.env`.
   Gere `DATA_ENCRYPTION_KEY` com `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` e guarde essa chave com segurança. Não altere a chave depois que houver cadastros.
3. Nos quatro canais de atendimento, habilite tópicos privados e dê ao bot as permissões necessárias.
4. Dê ao cargo de staff a permissão **Gerenciar tópicos**, para que seus membros possam acessar e conversar nos tickets privados.
5. Execute `npm start`.

O bot registra os comandos diretamente no servidor configurado por `GUILD_ID`, cria `tickets.db` automaticamente e mantém um único painel principal no canal configurado.

## Permissões dos tickets

- Preencha `DIRETOR_ROLE_ID`, `GERENTE_ROLE_ID`, `SUPORTE_ROLE_ID` e `AUXILIAR_ROLE_ID`.
- O cargo `FILA` não deve ser configurado.
- Director, Gerente, Suporte e Auxiliar podem usar todos os controles administrativos dos tickets, incluindo fechamento.
- ADM Shadow, Fila e cargos abaixo não podem fechar tickets.
- `STAFF_ROLE_ID` continua sendo usado em recursos internos/painel de mediadores, mas as permissões dos tickets usam os cargos separados acima.

## Railway

1. Crie um Volume no serviço e monte-o em `/data`.
2. Configure `DATA_DIR=/data` nas variáveis do Railway.
3. Cadastre no Railway todas as demais variáveis do `.env`, especialmente `DATA_ENCRYPTION_KEY`.
4. Use `npm start` como comando de inicialização.

O banco `tickets.db` e seus arquivos WAL ficam dentro do volume persistente. Sem o volume montado em `/data`, os dados serão perdidos quando o container for recriado.

## Comandos

- `/setup-ticket` — recria o painel principal.
- `/ticket-info` — exibe os dados do ticket do tópico atual.
- `/ticket-fechar` — fecha o ticket do tópico atual.
- `/mediador-dados usuario:@usuario` — consulta dados completos em resposta privada, restrita a `OWNER_ROLE_ID` ou `DONO_USER_ID`.
- `/setup-mediadores` — recria o painel fixo de administração de mediadores.

Os comandos de configuração exigem cargo operacional ou permissão de administrador. O fechamento exige Auxiliar ou superior, Owner/Dono ou Administrador.
