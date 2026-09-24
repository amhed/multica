/**
 * Optimistic send burst for the Chat tab.
 *
 * Mirrors web's chat-window.tsx send sequence
 * (packages/views/chat/components/chat-window.tsx):
 *   seed messages → seed pendingTask → flip activeSessionId → POST →
 *   patch pendingTask with server task_id + created_at.
 *
 * Send is not a useMutation — the burst doesn't map cleanly onto one.
 */
import { useCallback, useRef } from "react";
import { Alert } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import type { Agent, ChatMessage, ChatPendingTask } from "@multica/core/types";
import {
  enqueuePendingChatTask,
  removePendingChatTask,
} from "@multica/core/chat/pending";
import { api } from "@/data/api";
import { chatKeys } from "@/data/queries/chat";
import { useCreateChatSession } from "@/data/mutations/chat";
import { useChatDraftsStore } from "@/data/stores/chat-drafts-store";
import { seedAcceptedPendingTask } from "@/data/realtime/chat-ws-updaters";
import { dispatchReasonCode } from "@/lib/dispatch-reason";
import { useT } from "@/lib/i18n";

export function useChatSend(args: {
  activeSessionId: string | null;
  currentAgent: Agent | null;
  accessRevoked?: boolean;
  runtimeBound: boolean;
  setActiveSessionId: (id: string) => void;
}) {
  const {
    activeSessionId,
    currentAgent,
    accessRevoked = false,
    runtimeBound,
    setActiveSessionId,
  } = args;
  const qc = useQueryClient();
  const { t } = useT("chat");
  const sendFailureMessage = useCallback((err: unknown) => {
    switch (dispatchReasonCode(err)) {
      case "invocation_not_allowed":
        return t("failure.invocation_not_allowed");
      case "agent_runtime_required":
        return t("failure.agent_runtime_required");
      case "runtime_access_denied":
        return t("failure.runtime_access_denied", {
          detail: t("failure.runtime_access_recovery"),
        });
      default:
        return t("failure.default");
    }
  }, [t]);
  const createSession = useCreateChatSession();
  const promoteNewDraft = useChatDraftsStore((s) => s.promoteNewDraft);
  const clearDraft = useChatDraftsStore((s) => s.clearDraft);
  const sessionPromiseRef = useRef<Promise<string | null> | null>(null);

  const ensureSession = useCallback(
    async (titleSeed: string): Promise<string | null> => {
      if (activeSessionId) return activeSessionId;
      if (!currentAgent) return null;
      if (sessionPromiseRef.current) return sessionPromiseRef.current;

      const promise = (async () => {
        try {
          const session = await createSession.mutateAsync({
            agent_id: currentAgent.id,
            title: titleSeed.slice(0, 50),
          });
          return session.id;
        } finally {
          sessionPromiseRef.current = null;
        }
      })();
      sessionPromiseRef.current = promise;
      return promise;
    },
    [activeSessionId, currentAgent, createSession],
  );

  const send = useCallback(
    async (
      content: string,
      attachmentIds: string[] = [],
      options: { clearDraft?: boolean } = {},
    ) => {
      if (!currentAgent) return;
      // Invoke permission was revoked while this session was open — the server
      // would refuse before persisting anything. The composer is disabled in
      // this state; this is the belt-and-braces guard.
      if (accessRevoked) {
        Alert.alert(
          t("alerts.no_permission_title"),
          t("alerts.no_permission_message"),
        );
        return;
      }
      if (!runtimeBound) {
        Alert.alert(
          t("alerts.runtime_title"),
          t("alerts.runtime_message"),
        );
        return;
      }

      const isNewSession = !activeSessionId;
      let sessionId: string | null;
      try {
        sessionId = await ensureSession(content);
      } catch (err) {
        // Session create runs the same invoke gate as a send, so a permission
        // change refuses here too — and this is the only layer that sees the
        // reason code (MUL-6380).
        Alert.alert(t("alerts.not_sent"), sendFailureMessage(err));
        throw err;
      }
      if (!sessionId) return;

      const sentAt = new Date().toISOString();
      const optimistic: ChatMessage = {
        id: `optimistic-${Date.now()}`,
        chat_session_id: sessionId,
        role: "user",
        content,
        task_id: null,
        created_at: sentAt,
      };
      const optimisticTaskId = `optimistic-${optimistic.id}`;
      qc.setQueryData<ChatMessage[]>(chatKeys.messages(sessionId), (old) =>
        old ? [...old, optimistic] : [optimistic],
      );
      qc.setQueryData<ChatPendingTask>(
        chatKeys.pendingTask(sessionId),
        (old) =>
          enqueuePendingChatTask(
            old,
            {
              task_id: optimisticTaskId,
              status: "queued",
              created_at: sentAt,
              message_id: optimistic.id,
              content,
            },
            Boolean(old?.task_id),
          ),
      );
      if (isNewSession) {
        promoteNewDraft(sessionId);
        setActiveSessionId(sessionId);
      }

      try {
        const result = await api.sendChatMessage(sessionId, content, {
          attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        });
        qc.setQueryData<ChatMessage[]>(chatKeys.messages(sessionId), (old) =>
          old?.map((message) =>
            message.id === optimistic.id
              ? {
                  ...message,
                  id: result.message_id,
                  task_id: result.task_id,
                  created_at: result.created_at,
                }
              : message,
          ),
        );
        seedAcceptedPendingTask(qc, {
          chat_session_id: sessionId,
          task_id: result.task_id,
          created_at: result.created_at,
          message_id: result.message_id,
          content,
          optimistic_task_id: optimisticTaskId,
          supports_queue: result.supports_queue,
          queued: result.queued,
        });
        qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
        if (options.clearDraft !== false) {
          clearDraft(sessionId);
        }
      } catch (err) {
        qc.setQueryData<ChatMessage[]>(chatKeys.messages(sessionId), (old) =>
          old ? old.filter((m) => m.id !== optimistic.id) : old,
        );
        qc.setQueryData<ChatPendingTask>(
          chatKeys.pendingTask(sessionId),
          (old) => removePendingChatTask(old, optimisticTaskId),
        );
        throw err;
      }
    },
    [
      activeSessionId,
      currentAgent,
      accessRevoked,
      runtimeBound,
      ensureSession,
      qc,
      sendFailureMessage,
      t,
      promoteNewDraft,
      clearDraft,
      setActiveSessionId,
    ],
  );

  return { send };
}
