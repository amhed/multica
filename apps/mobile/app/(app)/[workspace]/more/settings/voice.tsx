/**
 * Personal-build Voice keys. Stored in SecureStore on this device only.
 * Env vars (EXPO_PUBLIC_*) still work as a fallback.
 */
import { useEffect, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useVoiceKeysStore } from "@/data/stores/voice-keys-store";
import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  mergeVoiceConfig,
  readVoiceClientConfig,
} from "@/lib/voice/config";

export default function VoiceSettingsScreen() {
  const keys = useVoiceKeysStore((s) => s.keys);
  const hydrated = useVoiceKeysStore((s) => s.hydrated);
  const hydrate = useVoiceKeysStore((s) => s.hydrate);
  const save = useVoiceKeysStore((s) => s.save);

  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [elevenLabsApiKey, setElevenLabsApiKey] = useState("");
  const [elevenLabsVoiceId, setElevenLabsVoiceId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  useEffect(() => {
    if (!hydrated) return;
    const effective = mergeVoiceConfig(keys, readVoiceClientConfig());
    setOpenaiApiKey(keys.openaiApiKey);
    setElevenLabsApiKey(keys.elevenLabsApiKey);
    setElevenLabsVoiceId(effective.elevenLabsVoiceId);
  }, [hydrated, keys]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await save({
        openaiApiKey,
        elevenLabsApiKey,
        elevenLabsVoiceId,
      });
    } catch (err) {
      Alert.alert(
        "Couldn't save keys",
        err instanceof Error ? err.message : "Please try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="px-4 py-6 gap-6"
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-sm text-muted-foreground">
        These stay on this phone. They are never sent to the Multica
        server — only to OpenAI (Whisper) and ElevenLabs (speech).
      </Text>

      <View className="gap-4">
        <View>
          <Text className="text-xs text-muted-foreground mb-1.5">
            OpenAI API key
          </Text>
          <TextField
            value={openaiApiKey}
            onChangeText={setOpenaiApiKey}
            placeholder="sk-..."
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            secureTextEntry
            textContentType="password"
          />
        </View>
        <View>
          <Text className="text-xs text-muted-foreground mb-1.5">
            ElevenLabs API key
          </Text>
          <TextField
            value={elevenLabsApiKey}
            onChangeText={setElevenLabsApiKey}
            placeholder="xi-..."
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            secureTextEntry
            textContentType="password"
          />
        </View>
        <View>
          <Text className="text-xs text-muted-foreground mb-1.5">
            ElevenLabs voice ID
          </Text>
          <TextField
            value={elevenLabsVoiceId}
            onChangeText={setElevenLabsVoiceId}
            placeholder={DEFAULT_ELEVENLABS_VOICE_ID}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
          />
          <Text className="text-xs text-muted-foreground mt-1.5">
            The ElevenLabs voice the agent speaks with. Paste any voice ID
            from your ElevenLabs library.
          </Text>
        </View>
      </View>

      <Button onPress={() => void handleSave()} disabled={saving || !hydrated}>
        <Text>{saving ? "Saving…" : "Save"}</Text>
      </Button>
    </ScrollView>
  );
}
