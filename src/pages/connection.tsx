import { activityHref } from "./activity-links";
import type { Setting } from "../permissions/store";
import { useRef, useState } from "react";
import {
  BanIcon,
  CircleCheckIcon,
  CircleQuestionMarkIcon,
  ChevronDownIcon,
  EllipsisIcon,
  MailIcon,
  XIcon,
} from "lucide-react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ConnectionView } from "../connections/model";
import { GROUPS } from "../mcp/groups";
import type { FramePage } from "./page";
import { OwnerFrame } from "./frame";
import { AccountStatusText } from "./accounts";
import { postAction } from "./actions";
import { outcomeMessage, permissionMessage } from "./connection-actions";

type Props = Omit<Extract<FramePage, { _tag: "Connection" }>, "_tag">;
type Account = Props["accounts"][number];
type Tool = Props["tools"][number];
type Action = "name" | "revoke";
type ControlState = { value: Setting; phase: "confirmed" | "saving" } | { phase: "unconfirmed" };
/** A change that waits for the owner's confirmation: one tool to Allowed, or every tool. */
type Pending =
  | { account: Account; tool: Tool; wanted: "allow" }
  | { account: Account; tool: null; wanted: "ask" | "allow" };
const values = [
  { value: "deny", label: "Not allowed", icon: BanIcon },
  { value: "ask", label: "Ask first", icon: CircleQuestionMarkIcon },
  { value: "allow", label: "Allowed", icon: CircleCheckIcon },
] as const;
const labelOf = (setting: Setting) => values.find((value) => value.value === setting)!.label;
const selected: Record<Setting, string> = {
  deny: "data-[state=on]:bg-background aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-xs aria-checked:hover:bg-background",
  ask: "data-[state=on]:bg-background aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-xs aria-checked:ring-1 aria-checked:ring-foreground aria-checked:ring-inset aria-checked:hover:bg-background",
  allow:
    "data-[state=on]:bg-primary aria-checked:bg-primary aria-checked:text-primary-foreground aria-checked:hover:bg-primary aria-checked:hover:text-primary-foreground",
};
const keyOf = (account: Account, tool: Tool) => `${account.id}:${tool.name}`;
const listOf = (names: readonly string[], className: string) =>
  new Intl.ListFormat("en", { style: "long", type: "conjunction" })
    .formatToParts(names)
    .map((part, i) => (
      <span key={i} className={part.type === "element" ? className : undefined}>
        {part.value}
      </span>
    ));
const commonValue = (states: readonly ControlState[]): Setting | "" => {
  const first = states[0];
  if (!first || first.phase === "unconfirmed") return "";
  return states.every((state) => state.phase !== "unconfirmed" && state.value === first.value)
    ? first.value
    : "";
};
const countsOf = (states: readonly ControlState[]) =>
  values
    .toReversed()
    .map(({ value, label }) => ({
      label: label.toLowerCase(),
      count: states.filter((state) => state.phase !== "unconfirmed" && state.value === value)
        .length,
    }))
    .filter(({ count }) => count > 0)
    .map(({ count, label }) => `${count} ${label}`)
    .join(" · ");

export function ConnectionPage(props: Props) {
  const [connection, setConnection] = useState(props.connection);
  const [dialog, setDialog] = useState<Action | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const groups = GROUPS.map((name) => ({
    name,
    tools: props.tools.filter((tool) => tool.group === name),
  })).filter((group) => group.tools.length > 0);
  const [controls, setControls] = useState<Record<string, ControlState>>(() =>
    Object.fromEntries(
      props.accounts.flatMap((a) =>
        props.tools.map((t) => {
          const key = `${a.id}:${t.name}` as const;
          return [key, { phase: "confirmed", value: props.settings[key] ?? "deny" }];
        }),
      ),
    ),
  );
  // A synchronous lock also covers two input events before React commits the saving state.
  const locked = useRef(new Set<string>());
  const [closed, setClosed] = useState(
    () => new Set(groups.length > 1 ? props.accounts.slice(1).map((account) => account.id) : []),
  );
  const [message, setMessage] = useState<string | null>(null);
  const active = connection.status.kind === "active";
  const visible = props.accounts.filter((a) =>
    props.tools.some((t) => {
      const state = controls[`${a.id}:${t.name}`];
      return state && state.phase !== "unconfirmed" && state.value !== "deny";
    }),
  );
  const uncertain = Object.values(controls).some((s) => s.phase === "unconfirmed");
  const summary = (names: string[]) =>
    names.length ? (
      <>
        <span className="font-medium">{connection.name}</span> can see{" "}
        {listOf(names, "font-medium")}.
      </>
    ) : (
      <span className="font-medium">{connection.name} can't see any of your accounts yet.</span>
    );
  const uncertainSummary = `Reload the page to confirm which accounts ${connection.name} can see.`;
  const save = async (account: Account, tools: readonly Tool[], wanted: Setting) => {
    const before = tools.map((tool) => ({
      key: keyOf(account, tool),
      state: controls[keyOf(account, tool)]!,
    }));
    if (before.some(({ key, state }) => state.phase !== "confirmed" || locked.current.has(key)))
      return;
    if (before.every(({ state }) => state.phase !== "unconfirmed" && state.value === wanted))
      return;
    for (const { key } of before) locked.current.add(key);
    setMessage(null);
    setControls((previous) => ({
      ...previous,
      ...Object.fromEntries(
        before.map(({ key, state }): [string, ControlState] => [
          key,
          state.phase === "unconfirmed" ? state : { ...state, phase: "saving" },
        ]),
      ),
    }));
    const { outcome } = await postAction(`/connections/${connection.id}/permissions`, [
      ["account", account.id],
      ["setting", wanted],
      // Allowed goes only to the tools that the page shows at another value, the ones that the
      // dialog counted. In a page that is out of date, a tool that it shows as Allowed is then
      // not granted without being named. Ask first and Not allowed go to every tool.
      ...tools
        .filter((_, i) => {
          const { state } = before[i]!;
          return wanted !== "allow" || (state.phase !== "unconfirmed" && state.value !== "allow");
        })
        .map((tool): [string, string] => ["tool", tool.name]),
    ]);
    setControls((previous) => ({
      ...previous,
      ...Object.fromEntries(
        before.map(({ key, state }): [string, ControlState] => [
          key,
          outcome === "unknown"
            ? { phase: "unconfirmed" }
            : outcome === "ok"
              ? { phase: "confirmed", value: wanted }
              : state,
        ]),
      ),
    }));
    if (outcome !== "unknown") for (const { key } of before) locked.current.delete(key);
    // Only Dismiss or the owner's next change clears a notice. A save that was already in flight
    // must not hide it; only "couldn't confirm", the one that warns of unknown access, replaces it.
    const notice = permissionMessage(outcome, connection.name);
    const uncertainNotice = permissionMessage("unknown", connection.name);
    if (notice) setMessage((current) => (current && notice !== uncertainNotice ? current : notice));
  };
  const askToConfirm = (change: Pending) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPending(change);
  };
  const chooseAll = (account: Account, wanted: Setting) => {
    const states = props.tools.map((tool) => controls[keyOf(account, tool)]!);
    if (states.some((state) => state.phase !== "confirmed")) return;
    if (commonValue(states) === wanted) return;
    if (wanted === "deny") return void save(account, props.tools, wanted);
    askToConfirm({ account, tool: null, wanted });
  };
  // The tools that the page shows at another value, in the order it shows them. The dialog counts
  // them and names the irreversible ones.
  const changing = pending
    ? groups
        .flatMap((group) => group.tools)
        .filter((tool) => {
          const state = controls[keyOf(pending.account, tool)]!;
          return state.phase !== "unconfirmed" && state.value !== pending.wanted;
        })
    : [];
  const irreversible = changing.filter((tool) => tool.irreversible).map((tool) => tool.label);
  return (
    <OwnerFrame frame={props.frame}>
      <div className="flex flex-col gap-10">
        <div className="flex flex-col gap-4">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="/connections">Connections</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate">{connection.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="text-xl font-semibold tracking-tight wrap-anywhere">
                {connection.name}
              </h1>
              <p className="text-sm text-muted-foreground">
                {[
                  ...(connection.name !== connection.appLabel ? [connection.appLabel] : []),
                  active
                    ? "Active"
                    : `${connection.status.kind === "revoked" ? "Revoked" : "Expired"} ${connection.status.on}`,
                  `Last used ${connection.lastUsed}`,
                  `Created ${connection.created}`,
                ].join(" · ")}
              </p>
              <Button
                asChild
                variant="link"
                size="sm"
                className="h-auto justify-start self-start p-0"
              >
                <a
                  href={activityHref({
                    filter: { kind: "connection", id: connection.id },
                    before: null,
                  })}
                >
                  See its activity
                </a>
              </Button>
            </div>
            {active && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="-mr-2 shrink-0 text-muted-foreground"
                    aria-label={`Actions for ${connection.name}`}
                  >
                    <EllipsisIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setDialog("name")}>Rename</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setDialog("revoke")}>
                    Revoke
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        {!active ? (
          <div className="flex max-w-2xl flex-col gap-2">
            <p className="text-base font-medium">
              {connection.name} can't use any of your accounts.
            </p>
            <p className="text-sm text-muted-foreground">
              An ended connection cannot be given access. To use {connection.appLabel} again, add
              this server to it. It signs in as a new connection with no access.
            </p>
          </div>
        ) : props.accounts.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MailIcon />
              </EmptyMedia>
              <EmptyTitle>No Google accounts yet</EmptyTitle>
              <EmptyDescription>
                Connect a Google account first. Then choose here what {connection.name} can use.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild>
                <a href="/accounts">Go to Accounts</a>
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <TooltipProvider disableHoverableContent>
            <div className="flex flex-col gap-10">
              {/* Reserve the longest summaries so saving or changing access moves no control. */}
              <div className="grid max-w-2xl text-base wrap-anywhere">
                <p className="col-start-1 row-start-1" aria-live="polite">
                  {uncertain ? uncertainSummary : summary(visible.map((a) => a.name))}
                </p>
                {[summary(props.accounts.map((a) => a.name)), summary([]), uncertainSummary].map(
                  (text, i) => (
                    <p key={i} className="invisible col-start-1 row-start-1" aria-hidden>
                      {text}
                    </p>
                  ),
                )}
              </div>
              <section className="@container flex flex-col">
                <div className="flex max-w-2xl flex-col gap-1 pb-6">
                  <h2 className="text-base font-medium">Tool permissions</h2>
                  <p className="text-sm text-muted-foreground">
                    Choose what {connection.name} can use on each Google account. With Ask first,
                    each call waits until you approve it. {connection.name} sees an account once one
                    of its tools is set to Ask first or Allowed. A change applies to its next
                    request.
                  </p>
                </div>
                {props.accounts.map((account) => {
                  const open = !closed.has(account.id);
                  const states = props.tools.map((tool) => controls[keyOf(account, tool)]!);
                  const phase = states.some((state) => state.phase === "unconfirmed")
                    ? "unconfirmed"
                    : states.every((state) => state.phase === "saving")
                      ? "saving"
                      : "confirmed";
                  const value = commonValue(states);
                  const note =
                    phase === "unconfirmed"
                      ? "Unconfirmed"
                      : phase === "saving"
                        ? "Saving…"
                        : value
                          ? ""
                          : countsOf(states);
                  const showGroups =
                    !open && groups.length > 1 && !value && phase !== "unconfirmed";
                  return (
                    <Collapsible
                      key={account.id}
                      open={open}
                      onOpenChange={(next) =>
                        setClosed((previous) => {
                          const set = new Set(previous);
                          if (next) set.delete(account.id);
                          else set.add(account.id);
                          return set;
                        })
                      }
                      className="border-t py-6 last:border-b"
                    >
                      <div className="flex flex-col gap-4">
                        <div className="flex flex-col gap-1">
                          <h3>
                            <CollapsibleTrigger className="group/trigger flex w-full items-start justify-between gap-3 rounded-sm text-left text-base font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                              <span className="min-w-0 wrap-anywhere">{account.name}</span>
                              <ChevronDownIcon className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/trigger:rotate-180" />
                            </CollapsibleTrigger>
                          </h3>
                          <p className="text-sm wrap-anywhere text-muted-foreground">
                            {account.email}
                            {account.workspace && " · Workspace"}
                          </p>
                          {account.status.kind !== "ready" && (
                            <p className="max-w-2xl pt-1 text-sm text-muted-foreground">
                              <AccountStatusText
                                account={account}
                                requiredGmailScopes={props.requiredGmailScopes}
                              />{" "}
                              If a tool is set to Ask first or Allowed, {connection.name} sees this
                              problem too.{" "}
                              <a
                                href="/accounts"
                                className="text-foreground underline underline-offset-4"
                              >
                                {["needs_reconnect", "missing_access"].includes(account.status.kind)
                                  ? "Reconnect on Accounts"
                                  : "Go to Accounts"}
                              </a>
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          <p className="text-sm font-medium @3xl:w-44 @3xl:shrink-0">
                            {`All ${props.tools.length} tools`}
                          </p>
                          <p
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-muted-foreground"
                            aria-live="polite"
                          >
                            {note === "Saving…" && <Spinner aria-hidden className="size-3.5" />}
                            {note}
                          </p>
                          <PermissionControl
                            labelled
                            label={`All tools on ${account.name} for ${connection.name}`}
                            value={value}
                            phase={phase}
                            waiting={states.some((state) => state.phase === "saving")}
                            choose={(wanted) => chooseAll(account, wanted)}
                          />
                        </div>
                      </div>
                      {showGroups && (
                        <dl
                          className={cn(
                            "flex flex-col gap-1.5 pt-4 text-sm",
                            phase === "saving" && "opacity-50",
                          )}
                        >
                          {groups.map((group) => {
                            const states = group.tools.map(
                              (tool) => controls[keyOf(account, tool)]!,
                            );
                            const value = commonValue(states);
                            return (
                              <div key={group.name} className="flex gap-3">
                                <dt className="w-40 shrink-0 text-muted-foreground @3xl:w-44">
                                  {group.name}
                                </dt>
                                <dd
                                  className={cn(
                                    "min-w-0 flex-1",
                                    value === "deny" && "text-muted-foreground",
                                  )}
                                >
                                  {value ? labelOf(value) : countsOf(states)}
                                </dd>
                              </div>
                            );
                          })}
                        </dl>
                      )}
                      <CollapsibleContent>
                        <div className="flex flex-col gap-5 pt-6 @3xl:gap-3 @3xl:pt-4">
                          {groups.map((group) => {
                            const heading = `${account.id}-${group.name.replaceAll(" ", "-")}`;
                            return (
                              <div
                                key={group.name}
                                role="group"
                                aria-labelledby={heading}
                                className="flex flex-col gap-1 @3xl:flex-row @3xl:gap-3"
                              >
                                <h4
                                  id={heading}
                                  className="text-sm leading-snug text-muted-foreground @3xl:w-44 @3xl:shrink-0 @3xl:pt-1.5"
                                >
                                  {group.name}
                                </h4>
                                <ItemGroup className="min-w-0 flex-1 gap-0 has-data-[size=xs]:gap-0">
                                  {group.tools.map((tool) => {
                                    const state = controls[keyOf(account, tool)]!;
                                    return (
                                      <Item
                                        key={tool.name}
                                        size="xs"
                                        className="flex-nowrap items-start gap-3 rounded-none border-0 px-0 py-1"
                                      >
                                        <ItemContent className="min-w-0 py-0.5">
                                          <ItemTitle className="line-clamp-none font-normal">
                                            {tool.label}
                                          </ItemTitle>
                                          <ItemDescription className="line-clamp-none">
                                            {tool.description}
                                          </ItemDescription>
                                        </ItemContent>
                                        <ItemActions>
                                          <PermissionControl
                                            label={`${tool.label} on ${account.name} for ${connection.name}`}
                                            value={state.phase === "unconfirmed" ? "" : state.value}
                                            phase={state.phase}
                                            choose={(wanted) =>
                                              wanted === "allow" && tool.irreversible
                                                ? askToConfirm({ account, tool, wanted })
                                                : void save(account, [tool], wanted)
                                            }
                                          />
                                        </ItemActions>
                                      </Item>
                                    );
                                  })}
                                </ItemGroup>
                              </div>
                            );
                          })}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })}
              </section>
            </div>
          </TooltipProvider>
        )}
      </div>
      {message && (
        <div className="fixed right-28 bottom-4 left-4 z-30 max-w-md md:left-76">
          <Alert variant="warning" role="status" className="shadow-md">
            <AlertDescription>{message}</AlertDescription>
            <AlertAction>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Dismiss"
                onClick={() => setMessage(null)}
              >
                <XIcon />
              </Button>
            </AlertAction>
          </Alert>
        </div>
      )}
      {pending && (
        <AlertDialog open onOpenChange={(open) => !open && setPending(null)}>
          <AlertDialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              opener.current?.focus();
            }}
          >
            <AlertDialogHeader className="place-items-start text-left">
              <AlertDialogTitle className="wrap-anywhere">
                Set {pending.tool?.label ?? "all tools"} on {pending.account.name} to{" "}
                {labelOf(pending.wanted)}?
              </AlertDialogTitle>
              <AlertDialogDescription className="wrap-anywhere">
                {pending.tool ? (
                  <>
                    {connection.name} will be able to use {pending.tool.label} on{" "}
                    {pending.account.name} without asking you.{" "}
                    <span className="font-medium text-foreground">
                      What this tool does cannot be undone.
                    </span>
                  </>
                ) : (
                  <>
                    {pending.wanted === "ask" ? (
                      `${connection.name} will be able to call every tool on ${pending.account.name}, and each call will wait for your approval.`
                    ) : (
                      <>
                        {connection.name} will be able to use every tool on {pending.account.name}{" "}
                        without asking you
                        {irreversible.length === 1 && ", including "}
                        {irreversible.length > 1 && ", including these, which cannot be undone: "}
                        {listOf(irreversible, "font-medium text-foreground")}
                        {irreversible.length === 1 && ", which cannot be undone"}.
                      </>
                    )}{" "}
                    This changes {changing.length} {changing.length === 1 ? "tool" : "tools"}.
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  void save(
                    pending.account,
                    pending.tool ? [pending.tool] : props.tools,
                    pending.wanted,
                  )
                }
              >
                Set to {labelOf(pending.wanted)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {dialog && (
        <ConnectionDialog
          key={dialog}
          connection={connection}
          action={dialog}
          close={() => setDialog(null)}
          confirmed={(name) => {
            setMessage(null);
            setConnection((previous) =>
              name === undefined
                ? {
                    ...previous,
                    canSee: [],
                    status: {
                      kind: "revoked",
                      on: new Intl.DateTimeFormat("en-US", {
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      }).format(new Date()),
                    },
                  }
                : { ...previous, name },
            );
          }}
        />
      )}
    </OwnerFrame>
  );
}
function PermissionControl({
  label,
  value,
  phase,
  waiting = false,
  labelled = false,
  choose,
}: {
  label: string;
  value: Setting | "";
  phase: ControlState["phase"];
  waiting?: boolean;
  labelled?: boolean;
  choose: (value: Setting) => void;
}) {
  const blocked = phase !== "confirmed" || waiting;
  return (
    <ToggleGroup
      type="single"
      role="radiogroup"
      aria-label={label}
      aria-busy={phase === "saving"}
      aria-disabled={blocked}
      value={value}
      size="lg"
      spacing={0.5}
      className={cn(
        "shrink-0 rounded-lg bg-muted p-0.5",
        labelled && "w-full @3xl:w-fit",
        phase === "saving" && "opacity-50",
      )}
      onValueChange={(next) => {
        if (!blocked && next) choose(next as Setting);
      }}
    >
      {values.map((segment) => {
        const item = (
          <ToggleGroupItem
            key={segment.value}
            value={segment.value}
            role="radio"
            aria-label={segment.label}
            aria-checked={value === segment.value}
            aria-disabled={blocked}
            className={cn(
              "rounded-md text-muted-foreground hover:bg-transparent",
              labelled && "min-w-0 flex-1 gap-1.5 px-1.5 @3xl:flex-none @3xl:px-3",
              selected[segment.value],
            )}
            onClick={(event) => {
              if (blocked) event.preventDefault();
            }}
          >
            <segment.icon />
            {labelled && segment.label}
          </ToggleGroupItem>
        );
        return labelled ? (
          item
        ) : (
          <Tooltip key={segment.value}>
            <TooltipTrigger asChild>{item}</TooltipTrigger>
            <TooltipContent>{segment.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleGroup>
  );
}
function ConnectionDialog({
  connection,
  action,
  close,
  confirmed,
}: {
  connection: ConnectionView;
  action: Action;
  close: () => void;
  confirmed: (name?: string) => void;
}) {
  const [name, setName] = useState(connection.name);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const { outcome } = await postAction(
      `/connections/${connection.id}/${action}`,
      action === "name" ? { name } : {},
    );
    if (outcome === "ok") {
      confirmed(action === "name" ? name.trim() : undefined);
      close();
      return;
    }
    setMessage(outcomeMessage(outcome, connection.name));
    setBusy(false);
  };
  const feedback = message && (
    <Alert role="status">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
  if (action === "name")
    return (
      <Dialog open onOpenChange={(open) => !open && !busy && close()}>
        <DialogContent className="sm:max-w-sm">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="flex flex-col gap-6"
          >
            <DialogHeader>
              <DialogTitle className="wrap-anywhere">Rename {connection.name}</DialogTitle>
              <DialogDescription>Change the name shown on the Connections page.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rename">Name</Label>
              <Input
                id="rename"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                required
                disabled={busy}
              />
            </div>
            {feedback}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && close()}>
      <AlertDialogContent>
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle className="wrap-anywhere">Revoke {connection.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {connection.appLabel} stops working on its next request, and nothing it left waiting for
            your approval will run. You can't undo this.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {feedback}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            className="text-destructive"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? "Revoking…" : "Revoke"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
