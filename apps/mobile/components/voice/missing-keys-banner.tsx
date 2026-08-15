import { Pressable } from "react-native";
import { router } from "expo-router";
import { Text } from "@/components/ui/text";
import { useWorkspaceStore } from "@/data/workspace-store";

export function MissingKeysBanner() {
  const wsSlug = useWorkspaceStore((s) => s.currentWorkspaceSlug);

  return (
    <Pressable
      onPress={() => {
        if (!wsSlug) return;
        router.push(`/${wsSlug}/more/settings/voice`);
      }}
      className="mx-3 mt-2 mb-1 rounded-xl border border-border bg-secondary/50 px-3 py-2 active:opacity-80"
      accessibilityRole="button"
      accessibilityLabel="Add voice keys in Settings"
    >
      <Text className="text-sm font-medium text-foreground">
        Voice keys needed
      </Text>
      <Text className="text-xs text-muted-foreground mt-0.5">
        Add your OpenAI and ElevenLabs keys in Settings → Voice.
      </Text>
    </Pressable>
  );
}
