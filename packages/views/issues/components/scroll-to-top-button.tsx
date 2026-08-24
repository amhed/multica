"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";

/** Scroll offset (px) past which the button becomes visible. */
export const SCROLL_TO_TOP_THRESHOLD = 400;

/**
 * Floating "scroll to top" affordance for a scroll container. Renders inside
 * the scroller as a zero-height sticky strip, so it needs no changes to the
 * host layout and stays clear of the pinned composer at the bottom.
 */
export function ScrollToTopButton({ container }: { container: HTMLElement | null }) {
  const { t } = useT("issues");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!container) return;
    const update = () => setVisible(container.scrollTop > SCROLL_TO_TOP_THRESHOLD);
    update();
    container.addEventListener("scroll", update, { passive: true });
    return () => container.removeEventListener("scroll", update);
  }, [container]);

  if (!visible) return null;

  return (
    <div className="sticky top-0 z-10 h-0">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={t(($) => $.detail.scroll_to_top)}
        title={t(($) => $.detail.scroll_to_top)}
        className="absolute right-4 top-3 shadow-md"
        onClick={() => container?.scrollTo({ top: 0, behavior: "smooth" })}
      >
        <ArrowUp />
      </Button>
    </div>
  );
}
