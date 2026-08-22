import { Text } from "@/components/ui/text";
import type { VoicePhase } from "@/lib/voice/phase";

const COPY: Record<VoicePhase, string> = {
  idle: "Hold to talk",
  listening: "Listening",
  transcribing: "Transcribing",
  thinking: "Thinking",
  speaking: "Speaking — tap to stop",
  error: "Something went wrong",
};

export function VoiceStatusLabel({
  phase,
  disabledReason,
}: {
  phase: VoicePhase;
  disabledReason?: string;
}) {
  const label = disabledReason ?? COPY[phase];
  return (
    <Text
      className="text-sm text-muted-foreground text-center"
      accessibilityLiveRegion="polite"
    >
      {label}
    </Text>
  );
}
