# Custo da Reunião (call-monitor)

Extensão Chrome (MV3) que mede o custo de reuniões do Google Meet em tempo real.

## Instalar (dev)
1. `chrome://extensions` → Modo desenvolvedor → **Carregar sem compactação** → esta pasta.
2. Entre numa chamada no Meet: a janela do painel abre sozinha (ou clique no ícone da extensão).
3. Faça o check-in: **Média única**, **Por faixa** ou **Por pessoa** (valor individual; gera relatório por participante).

## Estrutura
- `src/adapter-meet.js` — único arquivo que conhece o DOM do Meet (frágil, ajustar aqui).
- `src/content.js` — publica `{inCall, count, title}` em `chrome.storage.local.meet`.
- `src/background.js` — abre/foca a janela popup do painel.
- `src/monitor.*` — painel: check-in, custo ao vivo, pausa, ajuste, resumo.
- Configurações (valores, faixas, histórico, CSV, import/export JSON) são uma tela dentro do painel (⚙), com botão Voltar.
- `managed-schema.json` — política corporativa (`chrome.storage.managed`) prevalece sobre config pessoal.
