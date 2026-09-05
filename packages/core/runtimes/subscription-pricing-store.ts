"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { defaultStorage } from "../platform/storage";

// Flat-rate subscriptions the team pays per provider (Claude Max, ChatGPT
// Pro for Codex, SuperGrok, ...). Usage through these is not metered, so the
// rate-table estimate on the Analytics page overstates what the team actually
// pays. When `enabled`, the dashboard replaces a subscribed provider's metered
// cost with its monthly fee prorated to the selected window. Stored globally
// (not workspace-scoped), like custom model pricing: the seat price is the
// same whichever workspace you are looking at.
//
// Keys are the lowercase provider slug the usage rows carry ("claude",
// "codex", "grok"), values are USD per month.
export const DEFAULT_SUBSCRIPTION_FEES: Readonly<Record<string, number>> = {
  claude: 200,
  codex: 100,
  grok: 100,
};

// Sentinel `model` on the synthetic usage rows that carry a subscription
// fee, so cost aggregations can route them to their own chart segment.
export const SUBSCRIPTION_MODEL = "__subscription__";

export interface SubscriptionPricingState {
  enabled: boolean;
  monthlyFees: Record<string, number>;
  setEnabled: (enabled: boolean) => void;
  // A fee of zero (or less) removes the provider: no subscription.
  setMonthlyFee: (provider: string, usd: number) => void;
}

const stateStorage = defaultStorage as unknown as StateStorage;

export const useSubscriptionPricingStore = create<SubscriptionPricingState>()(
  persist(
    (set) => ({
      enabled: false,
      monthlyFees: { ...DEFAULT_SUBSCRIPTION_FEES },
      setEnabled: (enabled) => set({ enabled }),
      setMonthlyFee: (provider, usd) =>
        set((state) => {
          const key = provider.trim().toLowerCase();
          const next = { ...state.monthlyFees };
          if (usd > 0) next[key] = usd;
          else delete next[key];
          return { monthlyFees: next };
        }),
    }),
    {
      name: "multica_runtime_subscription_pricing",
      storage: createJSONStorage(() => stateStorage),
    },
  ),
);

// Vanilla accessor for non-React callers: the monthly fee covering `provider`
// while subscriptions are on, else 0. `estimateCost` in
// packages/views/runtimes/utils.ts reads it so that usage on a subscribed
// provider prices at zero everywhere, not just on the dashboard.
export function getSubscriptionFee(provider: string | undefined): number {
  const { enabled, monthlyFees } = useSubscriptionPricingStore.getState();
  if (!enabled || !provider) return 0;
  return monthlyFees[provider.trim().toLowerCase()] ?? 0;
}
