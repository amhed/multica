/**
 * Voice tab header actions — same + affordance as Chat, plus a settings
 * button so voice ID / API keys are one tap away (not buried in More).
 */
import { IconButton } from "@/components/ui/icon-button";

interface Props {
  onSettingsPress: () => void;
  onNewPress: () => void;
}

export function VoiceHeaderActions({ onSettingsPress, onNewPress }: Props) {
  return (
    <>
      <IconButton
        name="settings-outline"
        onPress={onSettingsPress}
        accessibilityLabel="Voice settings"
      />
      <IconButton
        name="add"
        iconSize={24}
        onPress={onNewPress}
        accessibilityLabel="New conversation"
      />
    </>
  );
}
