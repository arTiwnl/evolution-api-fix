# Evolution API — Fork com correções de estabilidade e segurança

Este é um fork do [Evolution API](https://github.com/EvolutionAPI/evolution-api) focado em corrigir bugs reais de estabilidade de sessão, webhooks, integração com Chatwoot e a interface de gerenciamento (Manager), encontrados e corrigidos em auditoria de código + testes contra ambiente real.

> Documentação original do projeto: [doc.evolution-api.com](https://doc.evolution-api.com)
> Fork do Manager (frontend): [evolution-manager-v2](./evolution-manager-v2)

## Imagem Docker

```
artiwnl/evolution-api:fixed
artiwnl/evolution-api:2.3.7-fixed
```

Já inclui o Manager corrigido embutido em `/manager`.

---

## Bugs corrigidos

### 🔴 Críticos (afetam produção diretamente)

#### 1. Sessão do WhatsApp era apagada a cada reconexão
**Arquivo:** `src/utils/use-multi-file-auth-state-prisma.ts`

O código que lê/grava a sessão (credenciais criptográficas) no Postgres tinha duas camadas de bug que se cancelavam por acidente:
- `getAuthKey()` fazia `JSON.parse()` duas vezes em cima do mesmo dado ao ler, o que sempre falhava e fazia o sistema achar que não existia sessão salva — gerando uma sessão nova (vazia) e **sobrescrevendo a sessão real** a cada reconexão/restart.
- Ao corrigir a leitura, descobrimos uma segunda camada: `saveKey()` fazia `JSON.stringify()` em cima de um valor que **já vinha stringificado**, gravando o dado duplamente serializado no banco.

**Sintoma em produção:** múltiplas instâncias presas em loop de reconexão infinito, com erro `TypeError: Cannot read properties of undefined (reading 'public')` dentro do handshake do Baileys (`noise-handler.js`), porque a sessão carregada era uma string, não um objeto.

**Correção:** ambos os lados foram corrigidos, e a leitura agora **se autocura** — se encontrar uma sessão gravada com a camada dupla (dado legado, de antes do fix), ela decodifica corretamente e regrava no formato certo, sem descartar as credenciais originais (não força novo escaneamento de QR).

#### 2. Webhook do Chatwoot sem autenticação
**Arquivo:** `src/api/integrations/chatbot/chatwoot/routes/chatwoot.router.ts`

A rota que recebe eventos do Chatwoot (`POST /chatwoot/webhook/:instanceName`) não exigia nenhuma autenticação — diferente das outras rotas do mesmo arquivo. Qualquer pessoa que soubesse o nome de uma instância podia forjar uma requisição fingindo ser o Chatwoot, com `message_type: "outgoing"`, e fazer o WhatsApp conectado **enviar mensagens arbitrárias para qualquer contato**.

**Correção:** a rota agora exige uma `apikey` (global ou da instância) como query param na URL — a Evolution API já gera essa URL automaticamente com a chave embutida ao configurar o Chatwoot (`POST /chatwoot/set/:instance`).

> ⚠️ **Ação necessária após atualizar:** se você já tinha o Chatwoot configurado, a URL do webhook antiga (sem `apikey`) vai passar a receber `401`. Reconfigure a inbox no Chatwoot com a URL nova, ou rode `POST /chatwoot/set/:instance` de novo.

### 🟠 Alto impacto

#### 3. Baileys desatualizado (5 versões atrás, incluindo correção de segurança)
Atualizado de `7.0.0-rc.9` para `7.0.0-rc14`. No caminho:
- **rc12** trouxe correção de uma vulnerabilidade de segurança (advisory `GHSA-qvv5-jq5g-4cgg`).
- **rc13** corrigiu um bug em que o campo `fromMe` das mensagens vinha errado.
- A nova versão depende de um pacote nativo (`whatsapp-rust-bridge`) que é ESM-only e quebra em projetos CommonJS como este — corrigido com um script de `postinstall` (`scripts/fix-whatsapp-rust-bridge-exports.js`) que ajusta o `exports` do pacote automaticamente após todo `npm install`.

#### 4. Reconexão sem backoff podia gerar rate-limit do WhatsApp
**Arquivo:** `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`

Toda queda de conexão disparava uma nova tentativa **imediata**, sem espera. Adicionado backoff exponencial (1s até 30s) entre tentativas, resetado ao conectar com sucesso.

#### 5. `connectionUpdate()` sem tratamento de erro
Chamado de forma assíncrona sem `await` nem `.catch` — um erro interno virava uma rejeição não tratada e podia deixar a instância travada em estado `connecting` para sempre. Adicionado `.catch()` com log.

### 🟡 Webhooks

#### 6. Webhooks duplicados (local + global)
Se o webhook local de uma instância e o global apontavam para a mesma URL, o evento era enviado duas vezes. Agora o envio global é pulado quando a URL já é idêntica à local.

#### 7. Webhooks perdidos silenciosamente
`sendDataWebhook()` é chamado ~37 vezes no código sem `await`. Se a promise rejeitasse (ex: todas as tentativas de retry esgotadas), virava uma rejeição não tratada, sem log, sem rastro. Adicionado `try/catch` centralizado.

#### 8. Sem forma de identificar/deduplicar webhooks do lado do consumidor
Adicionado um `webhookId` estável no payload (baseado em instância + evento + id da mensagem), permitindo que o receptor detecte reentregas.

### 🟢 Chatwoot

#### 9. Conversa resolvida não reabria quando em cache
O ID da conversa fica em cache por 30 minutos. Se a conversa foi resolvida/fechada nesse intervalo, uma nova mensagem do cliente caía silenciosamente na conversa fechada em vez de reabri-la — a lógica de reabertura só rodava em cache miss.

#### 10. Vídeo-nota (círculo) nunca sincronizava
`ptvMessage` não estava na lista de tipos de mídia reconhecidos — a mensagem desaparecia sem erro nem placeholder.

#### 11. "Marcar como lida" podia marcar a mensagem errada
A query que busca a última mensagem não tinha `orderBy` nem filtro pela conversa específica — podia marcar como lida uma mensagem antiga de outra conversa.

#### 12. Contato duplicado no Chatwoot
A checagem de conflito ao criar contato só considerava o `identifier`, não o `phone_number` — o mesmo número podia acabar com dois contatos (ex: participando de dois grupos diferentes ao mesmo tempo).

#### 13. Notificação de erro de envio falhava em silêncio
Quando um envio ao WhatsApp falhava, o aviso disso para o Chatwoot não era `await`-ado nem tinha `.catch` — se essa notificação também falhasse, o operador não ficava sabendo de nada.

#### 14. Crash ao sincronizar mensagem que a instância manda direto pro grupo
Mensagens de grupo enviadas pelo próprio WhatsApp conectado (não pela API) têm `fromMe: true` mas não têm o campo `participant` — o código assumia que sempre existia e quebrava (`Cannot read properties of null/undefined (reading 'split')`). Corrigido com fallback para o JID da própria instância.

#### 15. Mensagens da própria instância disparando os bots (Typebot/OpenAI/Dify/etc)
Mensagens `fromMe: true` (enviadas pela própria instância, inclusive sync de outros dispositivos vinculados) disparavam os chatbots normalmente, podendo causar respostas indevidas ou loops. Agora só mensagens recebidas (`fromMe: false`) disparam os bots — o Chatwoot continua recebendo todas as mensagens normalmente, esse filtro é só para os bots.

#### 16. Checagem de integridade do campo `fromMe`
Para mensagens de grupo, adicionado um log de aviso (não altera comportamento) quando o `participant` da mensagem bate com o próprio número da instância mas o Baileys diz `fromMe: false` (ou vice-versa) — ajuda a diagnosticar inconsistências reportadas na lib.

---

## Evolution Manager (frontend)

Correções em [`evolution-manager-v2`](./evolution-manager-v2):

1. **Vazamento de configuração entre instâncias** — os formulários de Proxy/Webhook/Settings só resetavam quando a instância nova *tinha* configuração salva; ao trocar para uma instância sem config, continuavam mostrando (e podiam salvar por cima) os dados da instância anterior.
2. **WebSocket nunca era desconectado de verdade** — bug de comparação fazia `disconnectSocket()` nunca encontrar o socket a fechar, vazando conexões a cada visita ao chat.
3. **`socket.off(event)` sem handler apagava listeners de outros componentes** — como o socket é compartilhado entre componentes do chat, isso quebrava a atualização em tempo real da lista de conversas após trocar de conversa uma vez. Corrigido com contagem de referência e remoção seletiva de handler.
4. **Logout não limpava token de instância nem cache do react-query** — podia causar uso de credenciais antigas após novo login.
5. **Excluir instância pelo Dashboard usava token errado** — o passo de logout usava o token de instância (só setado ao visitar a página de detalhe dela), falhando silenciosamente para instâncias nunca abertas; a sessão do WhatsApp podia continuar ativa mesmo com a instância "deletada" no Manager.
6. **Criar instância sem validação de nome nem trava de duplo clique** — aceitava nome só com espaços, e clique duplo podia criar instância repetida.
7. **Diálogo de QR code travava em spinner infinito** se a conexão falhasse — sem erro, sem retry.
8. **Exclusão de bots (Typebot/OpenAI/Dify/N8n/EvolutionBot/Flowise/Evoai) falhava em silêncio** — erro só ia pro console, sem avisar o usuário.
9. **Redirecionamento errado após login** — usuário já autenticado acessando `/manager/login` caía na página de marketing (`/`) em vez do dashboard (`/manager/`).
10. **Aviso de versão do Baileys** — novo componente que avisa (com link pro changelog) quando o Baileys do servidor está desatualizado, ou confirma quando está em dia.

---

## Créditos

Correções feitas com apoio do Claude Code, a partir de auditoria de código e testes contra ambiente real (Postgres, Redis e build de produção via Docker).
