import type { ComponentType } from "react";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  AtSignIcon,
  BanIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  ClockIcon,
  HistoryIcon,
  PlugIcon,
  Repeat2Icon,
  SearchXIcon,
  ThumbsDownIcon,
  TimerOffIcon,
  XIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { activityHref } from "../activity/query";
import type { ActivityConnection, ActivityFilter, ActivityRecord } from "../activity/store";
import { OwnerFrame, PageHeader } from "./frame";
import type { FramePage } from "./page";

type Props = Extract<FramePage, { _tag: "Activity" }>;
type OutcomeKey = ActivityRecord["outcome"];
type Tone = "wait" | "bad" | "note" | "quiet";
/** The filter's order: what waits, then what went wrong, then what needs a look, then the rest. */
const OUTCOMES: ReadonlyArray<{
  key: OutcomeKey;
  label: string;
  tone: Tone;
  icon: ComponentType<{ className?: string }>;
  meaning: string;
}> = [
  {
    key: "pending",
    label: "Waiting",
    tone: "wait",
    icon: ClockIcon,
    meaning: "The call waits for your decision.",
  },
  {
    key: "refused",
    label: "Refused",
    tone: "bad",
    icon: BanIcon,
    meaning: "The call did nothing. The request, your settings, or Gmail did not allow it.",
  },
  {
    key: "failed",
    label: "Failed",
    tone: "bad",
    icon: CircleXIcon,
    meaning: "The call was allowed and did not complete.",
  },
  {
    key: "rejected",
    label: "Rejected",
    tone: "bad",
    icon: ThumbsDownIcon,
    meaning: "You rejected the call. Nothing ran.",
  },
  {
    key: "expired",
    label: "Expired",
    tone: "note",
    icon: TimerOffIcon,
    meaning: "Nobody decided within the hour. Nothing ran.",
  },
  {
    key: "unknown",
    label: "Unknown",
    tone: "note",
    icon: CircleHelpIcon,
    meaning:
      "No outcome. The call may still be running, or the server does not know whether it completed.",
  },
  {
    key: "repeat",
    label: "Repeat",
    tone: "quiet",
    icon: Repeat2Icon,
    meaning: "The connection sent the same call again. Nothing ran again.",
  },
  {
    key: "success",
    label: "Done",
    tone: "quiet",
    icon: CircleCheckIcon,
    meaning: "The call ran and completed.",
  },
];
const outcomeOf = (r: ActivityRecord) => OUTCOMES.find((o) => o.key === r.outcome)!;

const ended = (c: ActivityConnection) =>
  c.status.kind === "active"
    ? null
    : `${c.status.kind === "revoked" ? "Revoked" : "Expired"} ${c.status.on}`;
const href = (filter: ActivityFilter | null) => activityHref({ filter, before: null });

export function ActivityPage({ frame, query, load }: Props) {
  const filtered = query.filter !== null;
  const empty = !load.records.length && !filtered && query.before === null;
  return (
    <OwnerFrame frame={frame}>
      <div className="flex flex-col gap-8">
        <PageHeader
          title="Activity"
          description="Every tool call your connections made, newest first. Times are in UTC."
        />
        {empty ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HistoryIcon />
              </EmptyMedia>
              <EmptyTitle>No activity yet</EmptyTitle>
              <EmptyDescription>
                When an agent uses a tool through one of your connections, the call appears here
                with its outcome.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-6">
            <Filters query={query} load={load} clear={filtered && load.records.length > 0} />
            <div className="flex flex-col">
              {query.before !== null && (
                <div className="flex items-center justify-between gap-4 pb-2 text-sm text-muted-foreground">
                  <span>Older records</span>
                  <Button asChild variant="ghost" size="sm" className="-mr-2.5">
                    <a href={href(query.filter)}>Back to newest</a>
                  </Button>
                </div>
              )}
              {load.records.length > 0 ? (
                <ul aria-label="Records" className="flex flex-col">
                  {load.records.map((record, i) => (
                    <li key={record.id}>
                      {i > 0 && <Separator />}
                      <Record record={record} />
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty className="py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <SearchXIcon />
                    </EmptyMedia>
                    <EmptyTitle>
                      {filtered ? "No records match this filter" : "No older records"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {filtered
                        ? "Change the filter or clear it to see every record."
                        : "Go back to newest to see the latest records."}
                    </EmptyDescription>
                  </EmptyHeader>
                  {filtered && (
                    <EmptyContent>
                      <Button asChild variant="outline">
                        <a href={href(null)}>Clear filter</a>
                      </Button>
                    </EmptyContent>
                  )}
                </Empty>
              )}
              <div
                className={cn("flex flex-col gap-4", load.records.length > 0 && "border-t pt-4")}
              >
                <EndedNotice query={query} load={load} />
                {load.records.length > 0 && (
                  <div className="flex items-center justify-end gap-4">
                    {load.older !== null ? (
                      <Button asChild variant="outline">
                        <a href={activityHref({ filter: query.filter, before: load.older })}>
                          Older
                          <ArrowRightIcon />
                        </a>
                      </Button>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {filtered ? "No older matches" : "This is the first record"}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </OwnerFrame>
  );
}

function Filters({
  query,
  load,
  clear,
}: Pick<Props, "query" | "load"> & { readonly clear: boolean }) {
  const filter = query.filter;
  const connection =
    filter?.kind === "connection" ? load.connections.find((c) => c.id === filter.id) : null;
  const account = filter?.kind === "account" ? load.accounts.find((a) => a.id === filter.id) : null;
  const choices = [{ key: null, label: "All" }, ...OUTCOMES];
  return (
    <div className="flex flex-col gap-3">
      <nav aria-label="Outcome" className="-ml-2.5 flex flex-wrap gap-1">
        {choices.map((choice) => {
          const on =
            choice.key === null
              ? filter?.kind !== "outcome"
              : filter?.kind === "outcome" && filter.outcome === choice.key;
          return (
            <Button
              key={choice.label}
              asChild
              size="sm"
              variant={on ? "secondary" : "ghost"}
              className={cn(!on && "text-muted-foreground")}
            >
              <a
                href={href(choice.key === null ? null : { kind: "outcome", outcome: choice.key })}
                aria-current={on ? "true" : undefined}
              >
                {choice.label}
              </a>
            </Button>
          );
        })}
      </nav>
      <div className="flex items-center gap-2">
        <Choice
          label="Connection"
          current={
            connection?.name ??
            (filter?.kind === "connection" ? "Unknown connection" : "All connections")
          }
          note={connection && ended(connection) ? "ended" : null}
          icon={PlugIcon}
          all={{ label: "All connections", href: href(null) }}
          groups={[
            {
              label: null,
              items: load.connections
                .filter((c) => c.status.kind === "active")
                .map((c) => ({
                  id: c.id,
                  label: c.name,
                  note: null,
                  href: href({ kind: "connection", id: c.id }),
                })),
            },
            {
              label: "Ended",
              items: load.connections
                .filter((c) => c.status.kind !== "active")
                .map((c) => ({
                  id: c.id,
                  label: c.name,
                  note: ended(c),
                  href: href({ kind: "connection", id: c.id }),
                })),
            },
          ]}
          selected={filter?.kind === "connection" ? filter.id : undefined}
        />
        <Choice
          label="Account"
          current={
            account?.name ?? (filter?.kind === "account" ? "Unknown account" : "All accounts")
          }
          note={account?.removedOn ? "removed" : null}
          icon={AtSignIcon}
          all={{ label: "All accounts", href: href(null) }}
          groups={[
            {
              label: null,
              items: load.accounts
                .filter((a) => a.removedOn === null)
                .map((a) => ({
                  id: a.id,
                  label: a.name,
                  note: a.email,
                  href: href({ kind: "account", id: a.id }),
                })),
            },
            {
              label: "Removed",
              items: load.accounts
                .filter((a) => a.removedOn !== null)
                .map((a) => ({
                  id: a.id,
                  label: a.name,
                  note: `Removed ${a.removedOn}`,
                  href: href({ kind: "account", id: a.id }),
                })),
            },
          ]}
          selected={filter?.kind === "account" ? filter.id : undefined}
        />
        {clear && (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="shrink-0 px-2 text-muted-foreground md:px-2.5"
          >
            <a href={href(null)} aria-label="Clear filter">
              <XIcon />
              <span className="hidden md:inline">Clear filter</span>
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

/** Below the list so that changing a filter never moves the top of the list. */
function EndedNotice({ query, load }: Pick<Props, "query" | "load">) {
  const filter = query.filter;
  const connection =
    filter?.kind === "connection" ? load.connections.find((c) => c.id === filter.id) : null;
  const account = filter?.kind === "account" ? load.accounts.find((a) => a.id === filter.id) : null;
  const text =
    connection && connection.status.kind !== "active"
      ? `${connection.name} ended: ${connection.status.kind === "revoked" ? "you revoked it" : "it expired"} on ${connection.status.on}.`
      : account?.removedOn
        ? `You removed ${account.name} on ${account.removedOn}.`
        : null;
  return text ? (
    <p className="text-sm text-muted-foreground">{text} Its records stay here.</p>
  ) : null;
}
function Choice(props: {
  readonly label: string;
  readonly current: string;
  readonly note: string | null;
  readonly icon: ComponentType<{ className?: string }>;
  readonly all: { label: string; href: string };
  readonly groups: ReadonlyArray<{
    label: string | null;
    items: ReadonlyArray<{ id: string; label: string; note: string | null; href: string }>;
  }>;
  readonly selected: string | undefined;
}) {
  const Icon = props.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`${props.label}: ${props.current}`}
          className={cn(
            // Like a name in a record, only a long name shortens; a short one keeps its width.
            props.current.length > LONG_NAME ? "min-w-0 flex-1 basis-0 md:max-w-64" : "shrink-0",
            !props.selected && "text-muted-foreground",
          )}
        >
          <Icon />
          <span className="truncate">{props.current}</span>
          {props.note && (
            <span className="shrink-0 text-xs font-normal text-muted-foreground">{props.note}</span>
          )}
          <ChevronDownIcon className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-dvw">
        <DropdownMenuItem asChild>
          <a href={props.all.href}>
            <span className="flex-1">{props.all.label}</span>
            {!props.selected && <CheckIcon />}
          </a>
        </DropdownMenuItem>
        {props.groups.map(
          (g) =>
            g.items.length > 0 && (
              <div key={g.label ?? "main"}>
                <DropdownMenuSeparator />
                {g.label && (
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    {g.label}
                  </DropdownMenuLabel>
                )}
                {g.items.map((item) => (
                  <DropdownMenuItem key={item.id} asChild>
                    <a href={item.href} className="items-start">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="wrap-anywhere">{item.label}</span>
                        {item.note && (
                          <span className="truncate text-xs text-muted-foreground">
                            {item.note}
                          </span>
                        )}
                      </span>
                      {props.selected === item.id && <CheckIcon className="mt-0.5" />}
                    </a>
                  </DropdownMenuItem>
                ))}
              </div>
            ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const TONE: Readonly<Record<Tone, string>> = {
  wait: "",
  bad: "text-destructive font-medium",
  note: "text-foreground font-medium",
  quiet: "text-muted-foreground",
};

function OutcomeMark({ record }: { readonly record: ActivityRecord }) {
  const o = outcomeOf(record);
  const Icon = o.icon;
  return (
    <span className={cn("flex items-center gap-1.5", TONE[o.tone])}>
      <Icon className="size-4 shrink-0" />
      {o.label}
    </span>
  );
}

/** A name only shortens when it is long; shorter names keep their full width and wrap instead. */
const LONG_NAME = 24;

function Name({
  icon: Icon,
  name,
  extra,
  note,
  className,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly name: string;
  readonly extra?: string | null;
  readonly note: string | null;
  readonly className?: string;
}) {
  const long = name.length > LONG_NAME;
  return (
    <span
      className={cn(
        "flex min-h-6 items-center gap-1 text-muted-foreground",
        long ? "min-w-20 flex-1 basis-0" : "shrink-0",
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className={cn(long && "truncate")}>{name}</span>
      {extra && <span className="shrink-0">{extra}</span>}
      {note && <span className="shrink-0 text-xs">{note}</span>}
    </span>
  );
}

function Time({ time }: { readonly time: ActivityRecord["time"] }) {
  return (
    <time
      dateTime={time.iso}
      className={cn(
        "flex min-h-6 shrink-0 items-center tabular-nums",
        time.today ? "font-medium" : "text-muted-foreground",
      )}
    >
      {time.short}
    </time>
  );
}
const Opens = ({ className }: { readonly className?: string }) => (
  <span className={cn("flex h-6 shrink-0 items-center", className)}>
    <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
  </span>
);

function Record({ record: r }: { readonly record: ActivityRecord }) {
  const o = outcomeOf(r);
  const connection = r.connection;
  const account = r.account;
  const tool = r.tool?.label ?? "No such tool";
  const waiting = o.tone === "wait" && r.approval;
  const outcomeCell = "flex w-22 shrink-0 md:w-24";
  const toolName = (
    <span
      className={cn(
        "flex min-h-6 shrink-0 items-center",
        r.tool ? "font-medium" : "text-muted-foreground italic",
        "flex-1 md:flex-none",
      )}
    >
      {tool}
    </span>
  );
  const names = (
    <>
      {account ? (
        <Name
          icon={AtSignIcon}
          name={account.name}
          extra={r.also.length ? `+${r.also.length}` : null}
          note={account.removedOn ? "removed" : null}
        />
      ) : (
        r.tool &&
        r.tool.kind === "account" && (
          <span className="flex min-h-6 shrink-0 items-center text-muted-foreground">
            No account
          </span>
        )
      )}
      <Name icon={PlugIcon} name={connection.name} note={ended(connection) ? "ended" : null} />
    </>
  );
  return (
    <Collapsible>
      <div className="flex items-stretch gap-2 text-sm md:gap-3">
        {waiting && (
          // The whole outcome cell, the full height of the record, is the way to the approval.
          <Button
            asChild
            variant="ghost"
            className={cn(
              outcomeCell,
              "h-auto items-start justify-start rounded-none px-0 py-2.5 hover:bg-transparent dark:hover:bg-transparent",
            )}
          >
            <a
              href={`/approvals/${r.approval!.id}`}
              aria-label={`Waiting: open the approval of ${tool}`}
            >
              <Badge className="h-6 gap-1 px-2.5">
                {o.label}
                <ArrowUpRightIcon />
              </Badge>
            </a>
          </Button>
        )}
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            aria-label={`${o.label}: ${tool}, ${r.time.short}. Show details`}
            className="group h-auto min-w-0 flex-1 items-start justify-start gap-2 rounded-none px-0 py-2.5 text-left font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent aria-expanded:bg-transparent md:gap-3"
          >
            {!waiting && (
              <span className={cn(outcomeCell, "h-6 items-center")}>
                <OutcomeMark record={r} />
              </span>
            )}
            <>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:gap-3">
                <span className="flex items-start gap-2 md:contents">
                  {toolName}
                  <span className="md:hidden">
                    <Time time={r.time} />
                  </span>
                  <Opens className="md:hidden" />
                </span>
                <span className="flex min-w-0 flex-wrap gap-x-3 md:contents">{names}</span>
              </span>
              <span className="hidden md:block">
                <Time time={r.time} />
              </span>
              <Opens className="hidden md:flex" />
            </>
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <Details record={r} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function Details({ record: r }: { readonly record: ActivityRecord }) {
  const { connection, account } = r;
  const o = outcomeOf(r);
  const decided =
    r.approval?.decidedOn != null
      ? `${r.approval.state === "rejected" ? "You rejected it" : "You approved it"} on ${r.approval.decidedOn}`
      : null;
  const rows: ReadonlyArray<[string, React.ReactNode]> = [
    [
      "Outcome",
      <>
        <span className={cn(TONE[o.tone] || "font-medium")}>{o.label}.</span> {o.meaning}
      </>,
    ],
    [
      "Tool",
      r.tool ? (
        <>
          {r.tool.label}{" "}
          <code className="font-mono text-xs text-muted-foreground">{r.tool.name}</code>
        </>
      ) : (
        "The agent called a tool that this server does not have."
      ),
    ],
    [
      "Account",
      account ? (
        <>
          {account.name} <span className="text-muted-foreground">{account.email}</span>
          {account.removedOn && (
            <span className="block text-muted-foreground">
              You removed this account on {account.removedOn}.
            </span>
          )}
        </>
      ) : (
        <span className="text-muted-foreground">
          {!r.tool
            ? "None"
            : r.tool.kind === "plain"
              ? "None. This tool acts on no account."
              : "None. The call named no connected account."}
        </span>
      ),
    ],
    ...(r.also.length
      ? [
          [
            "Also used",
            <ul key="also" className="flex flex-col">
              {r.also.map((a) => {
                const other = a.account;
                return (
                  <li key={`${a.account.id}:${a.tool.name}`}>
                    {a.tool.label} on {other.name}
                    {other.removedOn && (
                      <span className="text-muted-foreground"> · removed {other.removedOn}</span>
                    )}
                  </li>
                );
              })}
            </ul>,
          ] as [string, React.ReactNode],
        ]
      : []),
    [
      "Connection",
      <>
        {connection.name}{" "}
        <span className="text-muted-foreground">
          {[
            connection.appLabel !== connection.name && connection.appLabel,
            ended(connection) && `Ended: ${ended(connection)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </>,
    ],
    ["Arrived", r.time.full],
    ...(decided ? [["Decided", decided] as [string, React.ReactNode]] : []),
  ];
  return (
    <div className="pb-5 md:pl-27">
      <dl className="grid max-w-xl grid-cols-4 gap-x-4 gap-y-2 text-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="col-span-4 grid grid-cols-subgrid">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="col-span-3 min-w-0 wrap-anywhere">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
