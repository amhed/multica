// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SUBSCRIPTION_FEES,
  useSubscriptionPricingStore,
} from "./subscription-pricing-store";

describe("useSubscriptionPricingStore", () => {
  beforeEach(() => {
    useSubscriptionPricingStore.setState({
      enabled: false,
      monthlyFees: { ...DEFAULT_SUBSCRIPTION_FEES },
    });
  });

  it("starts disabled with the default Claude / Codex / Grok monthly fees", () => {
    const s = useSubscriptionPricingStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.monthlyFees).toEqual({ claude: 200, codex: 100, grok: 100 });
  });

  it("toggles enabled", () => {
    useSubscriptionPricingStore.getState().setEnabled(true);
    expect(useSubscriptionPricingStore.getState().enabled).toBe(true);
  });

  it("sets a provider's monthly fee, keyed by lowercase slug", () => {
    useSubscriptionPricingStore.getState().setMonthlyFee("OpenCode", 50);
    expect(useSubscriptionPricingStore.getState().monthlyFees.opencode).toBe(50);
  });

  it("removes a provider when its fee drops to zero", () => {
    useSubscriptionPricingStore.getState().setMonthlyFee("grok", 0);
    expect(useSubscriptionPricingStore.getState().monthlyFees).toEqual({
      claude: 200,
      codex: 100,
    });
  });
});
