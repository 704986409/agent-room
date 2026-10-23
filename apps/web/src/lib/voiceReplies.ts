/** Agent reply voice (TTS autoplay + audio bar). Off unless VITE_AGENT_VOICE_REPLIES=1. */
export const AGENT_VOICE_REPLIES_ENABLED =
  String((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_AGENT_VOICE_REPLIES ?? '') === '1';
