/**
 * Strip markdown down to something ElevenLabs can read aloud. Voice is
 * a spoken overlay on the same chat message — we keep the words, drop
 * syntax and non-speech blocks (fences, images, URLs).
 */
export function toSpeakableText(markdown: string): string {
  let text = markdown.replace(/\r\n/g, "\n");
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/!\[[^\]]*]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]+)]\([^)]*\)/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n+/g, " ");
  return text.replace(/\s+/g, " ").trim();
}
