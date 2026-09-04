"use client";

import { CalendarDays, ChevronDown, CreditCard, FolderKanban } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import { providerDisplayName } from "@multica/core/runtimes";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@multica/ui/components/ui/dropdown-menu";
import { ProjectIcon } from "../../projects/components/project-icon";
import { useT } from "../../i18n";
import { ALL_PROJECTS, TIME_RANGES, type TimeRange } from "./dashboard-shared";

type DashboardProject = { id: string; title: string; icon: string | null };

/**
 * Page-scoped time range.
 *
 * A button that states the current value plus a single-select menu, rather
 * than five permanently-expanded segments. The five segments were the widest
 * thing in the header and the least informative: the value they encode is
 * already repeated in every KPI label ("Cost · 30D"). Collapsing them costs one
 * click per change and buys the header back.
 *
 * No "clear" entry: the range is a required parameter of every query on the
 * page, so it has no empty value to return to.
 */
export function TimeRangeFilter({
  days,
  onChange,
}: {
  days: TimeRange;
  onChange: (days: TimeRange) => void;
}) {
  const { t } = useT("usage");
  const current = TIME_RANGES.find((r) => r.days === days) ?? TIME_RANGES[2];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={t(($) => $.filter.period_label)}
            className="gap-1 px-2.5"
          >
            <CalendarDays className="size-3.5 text-muted-foreground" />
            <span className="tabular-nums">{current.label}</span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-auto min-w-32">
        <DropdownMenuRadioGroup
          value={String(days)}
          onValueChange={(value) => onChange(Number(value) as TimeRange)}
        >
          {TIME_RANGES.map((range) => (
            <DropdownMenuRadioItem
              key={range.days}
              value={String(range.days)}
              className="tabular-nums"
            >
              {range.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Page-scoped project filter.
 *
 * A single-level dropdown, deliberately not a generic "Filter" menu: with one
 * dimension, a wrapper menu only hides what is filterable behind an extra
 * hover. The trigger states the current value like `TimeRangeFilter` does:
 * a neutral outline throughout, showing the selected project's own icon and
 * name once narrowed — the named value is the active-state signal, no filled
 * tier. If a second dimension ships (agent, model, runtime), fold this back
 * into a combined menu in the `IssueDisplayControls` grammar.
 */
export function ProjectFilter({
  projects,
  projectValue,
  onProjectChange,
}: {
  projects: DashboardProject[];
  projectValue: string;
  onProjectChange: (value: string) => void;
}) {
  const { t } = useT("usage");
  const allLabel = t(($) => $.filter.all_projects);
  // A project id that no longer resolves (deleted project, or a stale id left
  // over from another workspace) counts as no filter — the same reading the
  // page applies when it derives the effective `projectId` for the queries, so
  // the chip cannot claim a filter the data is not actually narrowed by.
  const selected = projects.find((p) => p.id === projectValue);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={t(($) => $.filter.project_label)}
            className={selected ? "gap-1 px-2.5" : "gap-1 px-2.5 text-muted-foreground"}
          >
            {selected ? (
              <ProjectIcon project={selected} size="sm" />
            ) : (
              <FolderKanban className="size-3.5" />
            )}
            <span className="max-w-40 truncate">
              {selected ? selected.title : allLabel}
            </span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="max-h-72 w-auto min-w-52">
        <DropdownMenuRadioGroup
          value={projectValue}
          onValueChange={(value) => onProjectChange(value ?? ALL_PROJECTS)}
        >
          <DropdownMenuRadioItem value={ALL_PROJECTS}>
            <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{allLabel}</span>
          </DropdownMenuRadioItem>
          {projects.map((project) => (
            <DropdownMenuRadioItem key={project.id} value={project.id}>
              <ProjectIcon project={project} size="sm" />
              <span className="truncate">{project.title}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Page-scoped subscription pricing: a toggle plus a fee editor.
 *
 * Off, the page shows the metered rate-table estimate. On, every provider
 * with a monthly fee has that estimate replaced by the fee prorated to the
 * period (see applySubscriptionsToDaily). The on/off state is a toolbar
 * button of its own so it can be read and flipped without opening anything;
 * it follows the `ProjectFilter` grammar, muted while off and stating the
 * monthly total while on, with `aria-pressed` carrying the state. The fee
 * editor sits beside it as a popover with one field per provider seen in the
 * window, so a new runtime shows up as soon as it reports usage.
 */
export function SubscriptionsFilter({
  providers,
  enabled,
  fees,
  onEnabledChange,
  onFeeChange,
}: {
  providers: readonly string[];
  enabled: boolean;
  fees: Readonly<Record<string, number>>;
  onEnabledChange: (enabled: boolean) => void;
  onFeeChange: (provider: string, usd: number) => void;
}) {
  const { t, i18n } = useT("usage");
  const label = t(($) => $.filter.subscriptions_label);
  const monthlyTotal = providers.reduce((sum, p) => sum + (fees[p] ?? 0), 0);
  const money = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="outline"
        size="sm"
        aria-label={label}
        aria-pressed={enabled}
        onClick={() => onEnabledChange(!enabled)}
        className={
          enabled
            ? "gap-1 rounded-r-none px-2.5 font-medium"
            : "gap-1 rounded-r-none px-2.5 text-muted-foreground"
        }
      >
        <CreditCard className="size-3.5" />
        <span className="tabular-nums">
          {enabled
            ? t(($) => $.subscriptions.active_label, {
                amount: money.format(monthlyTotal),
              })
            : label}
        </span>
      </Button>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              aria-label={t(($) => $.subscriptions.edit_fees)}
              className="-ml-px rounded-l-none px-1.5 text-muted-foreground"
            >
              <ChevronDown className="size-3" />
            </Button>
          }
        />
        <PopoverContent align="end" className="w-72 space-y-3">
          <div className="text-body font-medium">{t(($) => $.subscriptions.title)}</div>
          <p className="text-caption text-muted-foreground">
            {t(($) => $.subscriptions.description)}
          </p>
          {providers.length === 0 ? (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.subscriptions.no_providers)}
            </p>
          ) : (
            <ul className="space-y-2">
              {providers.map((provider) => {
                const name = providerDisplayName(provider);
                const fieldId = `subscription-fee-${provider}`;
                return (
                  <li key={provider} className="flex items-center justify-between gap-3">
                    <Label htmlFor={fieldId} className="truncate">
                      {name}
                    </Label>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-caption text-muted-foreground">$</span>
                      <Input
                        id={fieldId}
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={1}
                        className="w-20 text-right tabular-nums"
                        value={fees[provider] ?? 0}
                        onChange={(e) => onFeeChange(provider, Number(e.target.value))}
                        aria-label={`${name} ${t(($) => $.subscriptions.per_month, { amount: "$" })}`}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
