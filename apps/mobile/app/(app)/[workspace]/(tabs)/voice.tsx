/**
 * Voice tab — hold-to-talk overlay on a real Multica chat session.
 *
 * Same agents, same send burst, same websocket loop as the Chat tab.
 * A spoken turn is a normal user/assistant message pair, so the
 * conversation is visible under Chat and on web/desktop.
 *
 * I/O is mobile-only: Whisper transcribes, ElevenLabs speaks. Keys
 * come from EXPO_PUBLIC_* in the local env (personal build).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  RecordingPresets,
  type AudioPlayer,
} from "expo-audio";
import * as Haptics from "expo-haptics";
import type { Agent, ChatPendingTask } from "@multica/core/types";
import {
  hideQueuedChatMessages,
  removePendingChatTask,
} from "@multica/core/chat/pending";
import { api } from "@/data/api";
import { useAuthStore } from "@/data/auth-store";
import { useWorkspaceStore } from "@/data/workspace-store";
import { agentListOptions } from "@/data/queries/agents";
import { memberListOptions } from "@/data/queries/members";
import {
  chatKeys,
  chatMessagesOptions,
  chatSessionsOptions,
  pendingChatTaskOptions,
  taskMessagesOptions,
} from "@/data/queries/chat";
import { useChatSessionRealtime } from "@/data/realtime/use-chat-session-realtime";
import { invalidatePendingTask } from "@/data/realtime/chat-ws-updaters";
import { useVoiceLastAgentStore } from "@/data/stores/voice-last-agent-store";
import { useChatSend } from "@/lib/use-chat-send";
import { canAssignAgent } from "@/lib/can-assign-agent";
import { useWorkspaceAgentAvailability } from "@/lib/workspace-agent-availability";
import { useAgentPresence } from "@/lib/use-agent-presence";
import { isAgentRuntimeBound } from "@/lib/is-agent-runtime-bound";
import { resolveVoiceAgent } from "@/lib/voice/resolve-agent";
import { latestSessionForAgent } from "@/lib/voice/latest-session";
import { toSpeakableText } from "@/lib/voice/speakable-text";
import {
  missingVoiceKeys,
  readVoiceClientConfig,
} from "@/lib/voice/config";
import { transcribeAudio } from "@/lib/voice/whisper";
import { playSpeechUri, synthesizeSpeech } from "@/lib/voice/elevenlabs";
import type { VoicePhase } from "@/lib/voice/phase";
import { Header } from "@/components/ui/header";
import { ChatMessageList } from "@/components/chat/chat-message-list";
import { AgentPickerSheet } from "@/components/chat/agent-picker-sheet";
import { NoAgentBanner } from "@/components/chat/no-agent-banner";
import { OfflineBanner } from "@/components/chat/offline-banner";
import { RuntimeRequiredBanner } from "@/components/chat/runtime-required-banner";
import { VoiceAgentButton } from "@/components/voice/voice-agent-button";
import { VoiceMicButton } from "@/components/voice/voice-mic-button";
import { VoiceStatusLabel } from "@/components/voice/voice-status-label";
import { MissingKeysBanner } from "@/components/voice/missing-keys-banner";

const MIN_HOLD_MS = 400;

export default function VoiceTab() {
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const userId = useAuthStore((s) => s.user?.id);

  const voiceConfig = useMemo(() => readVoiceClientConfig(), []);
  const missingKeys = useMemo(
    () => missingVoiceKeys(voiceConfig),
    [voiceConfig],
  );

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("idle");

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const playerRef = useRef<AudioPlayer | null>(null);
  const holdStartedAtRef = useRef<number | null>(null);
  const expectSpeechRef = useRef(false);
  const spokenMessageIdRef = useRef<string | null>(null);

  const lastAgentByWs = useVoiceLastAgentStore((s) => s.lastAgentByWs);
  const hydrateLastAgent = useVoiceLastAgentStore((s) => s.hydrate);
  const persistLastAgent = useVoiceLastAgentStore((s) => s.setLastAgent);

  useEffect(() => {
    if (wsId) void hydrateLastAgent(wsId);
  }, [wsId, hydrateLastAgent]);

  const { data: sessions = [] } = useQuery(chatSessionsOptions(wsId));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));

  const memberRole = useMemo(
    () => members.find((m) => m.user_id === userId)?.role,
    [members, userId],
  );

  const availableAgents = useMemo(
    () =>
      agents.filter(
        (a) => !a.archived_at && canAssignAgent(a, userId, memberRole),
      ),
    [agents, userId, memberRole],
  );

  const hydratedLastAgent =
    !!wsId && Object.prototype.hasOwnProperty.call(lastAgentByWs, wsId);
  const storedAgentId = wsId ? (lastAgentByWs[wsId] ?? null) : null;
  const currentAgent: Agent | null = useMemo(() => {
    if (!hydratedLastAgent) return null;
    if (selectedAgentId) {
      return availableAgents.find((a) => a.id === selectedAgentId) ?? null;
    }
    return resolveVoiceAgent(storedAgentId, availableAgents);
  }, [hydratedLastAgent, selectedAgentId, storedAgentId, availableAgents]);

  // Bind the voice surface to this agent's latest active session so a
  // spoken turn continues the same thread Chat / web would show.
  useEffect(() => {
    if (!currentAgent) {
      setActiveSessionId(null);
      return;
    }
    const latest = latestSessionForAgent(sessions, currentAgent.id);
    setActiveSessionId((current) => {
      if (latest) return latest.id;
      if (!current) return null;
      const known = sessions.find((session) => session.id === current);
      if (!known) return current;
      return known.agent_id === currentAgent.id ? current : null;
    });
  }, [currentAgent, sessions]);

  const { data: messages = [], isLoading: messagesLoading } = useQuery(
    chatMessagesOptions(activeSessionId),
  );
  const { data: pendingTask } = useQuery(
    pendingChatTaskOptions(activeSessionId),
  );
  const visibleMessages = hideQueuedChatMessages(messages, pendingTask);
  const { data: liveTaskMessages = [] } = useQuery(
    taskMessagesOptions(pendingTask?.task_id),
  );

  const availability = useWorkspaceAgentAvailability();
  const presenceDetail = useAgentPresence(wsId, currentAgent?.id);
  const presenceAvailability =
    presenceDetail === "loading" ? undefined : presenceDetail.availability;
  const runtimeBound =
    currentAgent !== null && isAgentRuntimeBound(currentAgent);

  useChatSessionRealtime(activeSessionId, () => {
    setActiveSessionId(null);
  });

  const { send } = useChatSend({
    activeSessionId,
    currentAgent,
    runtimeBound,
    setActiveSessionId,
  });

  const stopPlayer = useCallback(() => {
    const player = playerRef.current;
    playerRef.current = null;
    if (!player) return;
    try {
      player.pause();
      player.remove();
    } catch {
      // Player may already be released.
    }
  }, []);

  const handleStopTask = useCallback(() => {
    if (!pendingTask?.task_id || !activeSessionId) return;
    if (pendingTask.status === "queued") return;
    const taskId = pendingTask.task_id;
    const sessionId = activeSessionId;
    expectSpeechRef.current = false;
    qc.setQueryData<ChatPendingTask>(chatKeys.pendingTask(sessionId), (old) =>
      removePendingChatTask(old, taskId),
    );
    void api.cancelTaskById(taskId)
      .catch(() => {
        // Silent — task may have already terminated server-side.
      })
      .finally(() => invalidatePendingTask(qc, sessionId));
    setPhase("idle");
  }, [pendingTask?.task_id, pendingTask?.status, activeSessionId, qc]);

  const handleInterrupt = useCallback(() => {
    if (phase === "speaking") {
      stopPlayer();
      setPhase("idle");
      return;
    }
    if (phase === "thinking") {
      handleStopTask();
    }
  }, [phase, stopPlayer, handleStopTask]);

  const speakReply = useCallback(
    async (content: string) => {
      const speakable = toSpeakableText(content);
      if (!speakable) {
        setPhase("idle");
        return;
      }
      setPhase("speaking");
      try {
        const uri = await synthesizeSpeech(
          speakable,
          voiceConfig.elevenLabsApiKey,
          voiceConfig.elevenLabsVoiceId,
        );
        stopPlayer();
        const player = await playSpeechUri(uri);
        playerRef.current = player;
        player.addListener("playbackStatusUpdate", (status) => {
          if (!status.didJustFinish) return;
          stopPlayer();
          setPhase("idle");
        });
      } catch (err) {
        stopPlayer();
        setPhase("error");
        Alert.alert(
          "Couldn't speak the reply",
          err instanceof Error ? err.message : "ElevenLabs request failed.",
        );
        setPhase("idle");
      }
    },
    [voiceConfig, stopPlayer],
  );

  useEffect(() => {
    if (!expectSpeechRef.current) return;
    if (pendingTask?.task_id) return;
    const last = visibleMessages[visibleMessages.length - 1];
    if (!last || last.role !== "assistant") return;
    if (last.id === spokenMessageIdRef.current) return;
    if (last.failure_reason || last.message_kind === "no_response") {
      expectSpeechRef.current = false;
      setPhase("idle");
      return;
    }
    expectSpeechRef.current = false;
    spokenMessageIdRef.current = last.id;
    void speakReply(last.content);
  }, [visibleMessages, pendingTask?.task_id, speakReply]);

  useEffect(() => {
    return () => {
      stopPlayer();
    };
  }, [stopPlayer]);

  const handleHoldStart = useCallback(async () => {
    if (missingKeys.length > 0) return;
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Microphone needed",
        "Allow microphone access to talk to an agent.",
      );
      return;
    }
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      await recorder.prepareToRecordAsync();
      recorder.record();
      holdStartedAtRef.current = Date.now();
      setPhase("listening");
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (err) {
      setPhase("error");
      Alert.alert(
        "Couldn't start recording",
        err instanceof Error ? err.message : "Recorder failed.",
      );
      setPhase("idle");
    }
  }, [missingKeys.length, recorder]);

  const handleHoldEnd = useCallback(async () => {
    const startedAt = holdStartedAtRef.current;
    holdStartedAtRef.current = null;
    try {
      await recorder.stop();
    } catch {
      setPhase("idle");
      return;
    }
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
    });
    if (startedAt !== null && Date.now() - startedAt < MIN_HOLD_MS) {
      setPhase("idle");
      return;
    }
    const uri = recorder.uri;
    if (!uri) {
      setPhase("idle");
      return;
    }
    if (!currentAgent) {
      setPhase("idle");
      return;
    }

    setPhase("transcribing");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const text = await transcribeAudio(uri, voiceConfig.openaiApiKey);
      if (wsId) persistLastAgent(wsId, currentAgent.id);
      expectSpeechRef.current = true;
      setPhase("thinking");
      await send(text, [], { clearDraft: false });
    } catch (err) {
      expectSpeechRef.current = false;
      setPhase("error");
      Alert.alert(
        "Voice turn failed",
        err instanceof Error ? err.message : "Please try again.",
      );
      setPhase("idle");
    }
  }, [recorder, currentAgent, voiceConfig.openaiApiKey, wsId, persistLastAgent, send]);

  const handlePickAgent = useCallback(
    (agent: Agent) => {
      setSelectedAgentId(agent.id);
      if (wsId) persistLastAgent(wsId, agent.id);
      const latest = latestSessionForAgent(sessions, agent.id);
      setActiveSessionId(latest?.id ?? null);
    },
    [wsId, persistLastAgent, sessions],
  );

  const disabled =
    !currentAgent ||
    availability === "none" ||
    !runtimeBound ||
    missingKeys.length > 0;
  const disabledReason = !currentAgent
    ? "No agent selected"
    : availability === "none"
      ? "No agents in this workspace"
      : !runtimeBound
        ? "Agent needs a runtime"
        : missingKeys.length > 0
          ? "Voice keys missing"
          : undefined;

  return (
    <View className="flex-1 bg-background">
      <Header
        title="Voice"
        center={
          <VoiceAgentButton
            currentAgent={currentAgent}
            onPress={() => setAgentPickerOpen(true)}
          />
        }
      />
      {availability === "none" ? <NoAgentBanner /> : null}
      {missingKeys.length > 0 ? <MissingKeysBanner keys={missingKeys} /> : null}
      <ChatMessageList
        messages={visibleMessages}
        loading={messagesLoading}
        hasSessions={sessions.length > 0}
        agentName={currentAgent?.name}
        onPickPrompt={(text) => {
          if (disabled) return;
          if (currentAgent && wsId) persistLastAgent(wsId, currentAgent.id);
          expectSpeechRef.current = true;
          setPhase("thinking");
          void send(text, [], { clearDraft: false }).catch((err: unknown) => {
            expectSpeechRef.current = false;
            setPhase("idle");
            Alert.alert(
              "Couldn't send",
              err instanceof Error ? err.message : "Please try again.",
            );
          });
        }}
        onQuickAction={(action) => {
          if (currentAgent && wsId) persistLastAgent(wsId, currentAgent.id);
          expectSpeechRef.current = true;
          setPhase("thinking");
          return send(action.prompt, [], { clearDraft: false });
        }}
        quickActionsDisabled={!!pendingTask?.task_id || disabled}
        pendingTask={pendingTask}
        liveTaskMessages={liveTaskMessages}
        availability={presenceAvailability}
      />
      {runtimeBound ? (
        <OfflineBanner
          agentName={currentAgent?.name}
          availability={presenceAvailability}
        />
      ) : currentAgent ? (
        <RuntimeRequiredBanner agentName={currentAgent.name} />
      ) : null}
      <View style={{ paddingBottom: Math.max(insets.bottom, 8) }}>
        <VoiceStatusLabel phase={phase} disabledReason={disabledReason} />
        <VoiceMicButton
          phase={phase}
          disabled={disabled}
          onHoldStart={() => {
            void handleHoldStart();
          }}
          onHoldEnd={() => {
            void handleHoldEnd();
          }}
          onInterrupt={handleInterrupt}
        />
      </View>

      <AgentPickerSheet
        visible={agentPickerOpen}
        agents={availableAgents}
        currentAgentId={currentAgent?.id ?? null}
        onPick={handlePickAgent}
        onClose={() => setAgentPickerOpen(false)}
      />
    </View>
  );
}
