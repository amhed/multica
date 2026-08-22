/**
 * Strip markdown down to something ElevenLabs can read aloud. Voice is
 * a spoken overlay on the same chat message — we keep the words, drop
 * syntax, non-speech blocks, and tokens that sound terrible out loud
 * (file paths, long filenames, UUIDs, raw URLs).
 */

const FILE_EXT =
  "ts|tsx|js|jsx|mjs|cjs|go|json|md|mdx|css|sql|yml|yaml|png|jpe?g|svg|lock|txt|sh|env|swift|kt|rb|py|rs";

const PATH_WITH_FILE = new RegExp(
  String.raw`(?:[A-Za-z]:)?(?:/{1,2}[^\s/]+)+\.(?:${FILE_EXT})\b|(?:[\w.@{}[\]()-]+/){1,}[\w.@{}[\]()-]+\.(?:${FILE_EXT})\b`,
  "gi",
);

const BARE_FILENAME = new RegExp(
  String.raw`\b[\w.@{}[\]()-]{3,}\.(?:${FILE_EXT})\b`,
  "gi",
);

const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const RAW_URL = /https?:\/\/\S+/gi;

export const VOICE_REPLY_INSTRUCTION =
  "Reply for a voice conversation: conversational, no lists of file paths, no long filenames — use a short name if you must mention a file.";

export function withVoiceReplyInstruction(transcript: string): string {
  return `${transcript.trim()}\n\n${VOICE_REPLY_INSTRUCTION}`;
}

function speakableBasename(pathOrFile: string): string {
  const filename = pathOrFile.split("/").pop() ?? pathOrFile;
  const base = filename.replace(/\.[^.]+$/, "");
  const words = base.split(/[-_.]+/).filter((part) => part.length > 0);
  if (words.length === 0 || words.length > 4) return "a file";
  return words.join(" ");
}

export function toSpeakableText(markdown: string): string {
  let text = markdown.replace(/\r\n/g, "\n");
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/!\[[^\]]*]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]+)]\([^)]*\)/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(RAW_URL, "a link");
  text = text.replace(PATH_WITH_FILE, (match) => speakableBasename(match));
  text = text.replace(BARE_FILENAME, (match) => speakableBasename(match));
  text = text.replace(UUID, "an id");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n+/g, " ");
  return text.replace(/\s+/g, " ").trim();
}
