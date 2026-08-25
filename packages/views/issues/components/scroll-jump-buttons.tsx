"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";

/** Distance (px) from an edge past which the jump button for it is shown. */
export const SCROLL_JUMP_THRESHOLD = 400;

/**
 * Floating scroll-to-top / scroll-to-bottom pair for a scroll container.
 * Render it as a sibling of the scroller (not inside it), positioned by the
 * host via `className`: inside the scroller, the timeline's sticky comment
 * headers and collapse bars paint over anything at an equal or lower z.
 */
export function ScrollJumpButtons({
  container,
  className,
}: {
  container: HTMLElement | null;
  className?: string;
}) {
  const { t } = useT("issues");
  const [edges, setEdges] = useState({ farFromTop: false, farFromBottom: false });

  useEffect(() => {
    if (!container) return;
    const update = () => {
      const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
      setEdges({
        farFromTop: container.scrollTop > SCROLL_JUMP_THRESHOLD,
        farFromBottom: remaining > SCROLL_JUMP_THRESHOLD,
      });
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => {
      container.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [container]);

  if (!edges.farFromTop && !edges.farFromBottom) return null;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {edges.farFromTop && (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t(($) => $.detail.scroll_to_top)}
          title={t(($) => $.detail.scroll_to_top)}
          className="shadow-md"
          onClick={() => container?.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <ArrowUp />
        </Button>
      )}
      {edges.farFromBottom && (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t(($) => $.detail.scroll_to_bottom)}
          title={t(($) => $.detail.scroll_to_bottom)}
          className="shadow-md"
          onClick={() =>
            container?.scrollTo({ top: container.scrollHeight, behavior: "smooth" })
          }
        >
          <ArrowDown />
        </Button>
      )}
    </div>
  );
}
