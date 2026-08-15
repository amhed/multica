import { View } from "react-native";
import { Text } from "@/components/ui/text";

export function MissingKeysBanner({ keys }: { keys: string[] }) {
  return (
    <View className="mx-3 mt-2 mb-1 rounded-xl border border-border bg-secondary/50 px-3 py-2">
      <Text className="text-sm font-medium text-foreground">
        Voice keys missing
      </Text>
      <Text className="text-xs text-muted-foreground mt-0.5">
        Add {keys.join(", ")} to apps/mobile/.env.development.local and
        restart Metro.
      </Text>
    </View>
  );
}
