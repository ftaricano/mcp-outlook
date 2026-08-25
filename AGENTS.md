# AGENTS.md -- mcp-outlook

As regras operacionais deste repo são canônicas em [CLAUDE.md](CLAUDE.md). Leia-o antes de tocar em código.

TL;DR das invariantes:
- O servidor original expõe exatamente 40 tools; o plugin expõe 12 por padrão, 14 com handoffs locais, 17 com mailbox writes, 19 com ambos — e 13/15/18/20 com o gate de envio ligado. Mudança exige atualizar os smokes e a tabela do README
- Envio pelo plugin é um terceiro gate independente (`PLUGIN_ALLOW_SEND`), fail-closed no startup: o processo **recusa subir** se `OUTLOOK_SEND_FROM` não nomear uma caixa que esteja na allowlist do plugin E coberta por `OUTLOOK_ALLOWED_SENDERS`. A tool não aceita parâmetro de caixa. Delete continua impossível por construção em qualquer combinação
- Toda saída de e-mail (servidor original e plugin) passa por `src/security/senderPolicy.ts` antes da chamada Graph
- Toda entrada passa por schema zod antes do dispatch
- Filesystem sempre via `pathGuard`; Graph sempre via `EmailService`
- Busca negativa preserva `NOT_FOUND` vs estados incompletos/falhos; nunca converte erro de paginação em vazio limpo
- Telemetria é metadata-only; nunca persiste valores, conteúdo, anexos, credenciais ou erro bruto
- Repo público: nenhum dado real de tenant, mailbox, cliente ou empresa em código, docs, testes ou fixtures

Validar: `npm run build && npm test && npm run smoke`
