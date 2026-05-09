/**
 * Meeting → Issues harness
 *
 * Converte transcrições de reuniões do Google Meet em GitHub Issues.
 *
 * Setup:
 *   export GOOGLE_CREDENTIALS_PATH=~/.gates/google-credentials.json
 *   export GOOGLE_CALENDAR_ID=primary
 *   export GH_TOKEN=ghp_...
 *   export GITHUB_REPO=org/repo
 *
 * Uso no chat:
 *   /skill list-meetings days=7
 *   /skill extract-action-items transcript_file_id=<id> repo=org/repo
 *   /skill create-github-issues repo=org/repo title="..." description="..." meeting_title="..."
 */

export default {
  name: "Meeting Issues",
  description: "Converte transcrições do Google Meet em GitHub Issues",

  provider: {
    type: "anthropic",
    model: "claude-sonnet-4-6",
  },

  systemPrompt: `Você é um assistente especializado em gestão de projetos.
Sua função é ajudar a converter transcrições de reuniões em action items estruturados e criar GitHub Issues.

Fluxo típico:
1. Use /skill list-meetings para ver reuniões recentes com transcrição
2. Use /skill extract-action-items transcript_file_id=<id> repo=<org/repo> para extrair itens
3. Revise os itens extraídos na sidebar
4. Use /skill create-github-issues para cada item que deve virar um issue

Você também pode responder perguntas sobre as reuniões e ajudar a priorizar os itens.`,

  tools: ["read", "bash"],

  compaction: {
    maxContextTokens: 16000,
    thresholdPercent: 80,
    keepRecentMessages: 6,
  },
};
