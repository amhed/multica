/**
 * Header control for the Voice tab. Tap opens the agent picker.
 * Mirrors ChatTitleButton's tappable title + avatar, without the
 * session-switcher subtitle (Voice always continues that agent's
 * latest session).
 */
import { Pressable, View } from "react-native";
import type { Agent } from "@multica/core/types";
import { Text } from "@/components/ui/text";
import { ActorAvatar } from "@/components/ui/actor-avatar";

interface Props {
  currentAgent: Agent | null;
  onPress: () => void;
}

export function VoiceAgentButton({ currentAgent, onPress }: Props) {
  const agentName = currentAgent?.name ?? "Choose agent";

  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      className="flex-row items-center gap-2 px-2 py-1 rounded-lg active:bg-secondary"
      accessibilityRole="button"
      accessibilityLabel="Choose agent"
    >
      <ActorAvatar
        type={currentAgent ? "agent" : null}
        id={currentAgent?.id ?? null}
        size={24}
        showPresence
      />
      <View className="flex-row items-center gap-1 min-w-0">
        <Text
          className="text-base font-semibold text-foreground"
          numberOfLines={1}
        >
          {agentName}
        </Text>
        <Text className="text-xs text-muted-foreground">▼</Text>
      </View>
    </Pressable>
  );
}
