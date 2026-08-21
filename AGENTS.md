# AGENTS.md -- mcp-outlook

As regras operacionais deste repo são canônicas em [CLAUDE.md](CLAUDE.md). Leia-o antes de tocar em código.

TL;DR das invariantes:
- O servidor original expõe exatamente 40 tools; o plugin expõe 11 por padrão, 13 com handoffs locais, 16 com mailbox writes ou 18 com ambos. Mudança exige atualizar os smokes e a tabela do README
- Toda entrada passa por schema zod antes do dispatch
- Filesystem sempre via `pathGuard`; Graph sempre via `EmailService`
- Busca negativa preserva `NOT_FOUND` vs estados incompletos/falhos; nunca converte erro de paginação em vazio limpo
- Telemetria é metadata-only; nunca persiste valores, conteúdo, anexos, credenciais ou erro bruto
- Repo público: nenhum dado real de tenant, mailbox, cliente ou empresa em código, docs, testes ou fixtures

Validar: `npm run build && npm test && npm run smoke`
