import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { cn } from "@/lib/utils";
import type { VoicePhase } from "@/lib/voice/phase";

interface Props {
  phase: VoicePhase;
  disabled: boolean;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onInterrupt: () => void;
}

export function VoiceMicButton({
  phase,
  disabled,
  onHoldStart,
  onHoldEnd,
  onInterrupt,
}: Props) {
  const listening = phase === "listening";
  const transcribing = phase === "transcribing";
  const thinking = phase === "thinking";
  const speaking = phase === "speaking";
  const canHold = !disabled && (phase === "idle" || phase === "error");
  const canInterrupt = speaking || thinking;

  return (
    <View className="items-center justify-center py-4">
      <Pressable
        disabled={disabled || transcribing}
        onPressIn={() => {
          if (canInterrupt) {
            onInterrupt();
            return;
          }
          if (canHold) onHoldStart();
        }}
        onPressOut={() => {
          if (listening) onHoldEnd();
        }}
        accessibilityRole="button"
        accessibilityLabel={
          speaking
            ? "Stop speaking"
            : thinking
              ? "Stop the agent"
              : listening
                ? "Release to send"
                : "Hold to talk"
        }
        className={cn(
          "h-20 w-20 items-center justify-center rounded-full",
          listening && "bg-destructive",
          speaking && "bg-brand",
          !listening && !speaking && "bg-primary",
          (disabled || transcribing) && "opacity-40",
        )}
      >
        <Image
          source={listening ? "sf:mic.fill" : speaking ? "sf:stop.fill" : "sf:mic.fill"}
          tintColor="white"
          style={{ width: 32, height: 32 }}
        />
      </Pressable>
    </View>
  );
}
