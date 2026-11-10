import { useRef, useState } from "react";
import {
  BanIcon,
  CircleCheckIcon,
  ChevronDownIcon,
  EllipsisIcon,
  MailIcon,
  XIcon,
} from "lucide-react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ConnectionView } from "../connections/model";
import type { FramePage } from "./page";
import { OwnerFrame } from "./frame";
import { AccountStatusText } from "./accounts";
import { postAction } from "./actions";
import { outcomeMessage, permissionMessage } from "./connection-actions";

type Props = Omit<Extract<FramePage, { _tag: "Connection" }>, "_tag">;
type Action = "name" | "revoke";
type ControlState = { value: boolean; phase: "confirmed" | "saving" } | { phase: "unconfirmed" };
const values = [
  { value: "true", label: "Allowed", icon: CircleCheckIcon },
  { value: "false", label: "Not allowed", icon: BanIcon },
] as const;

export function ConnectionPage(props: Props) {
  const [connection, setConnection] = useState(props.connection);
  const [dialog, setDialog] = useState<Action | null>(null);
  const [controls, setControls] = useState<Record<string, ControlState>>(() =>
    Object.fromEntries(
      props.accounts.flatMap((a) =>
        props.tools.map((t) => {
          const key = `${a.id}:${t.name}` as const;
          return [key, { phase: "confirmed", value: props.allowed.includes(key) }];
        }),
      ),
    ),
  );
  // A synchronous lock also covers two input events before React commits the saving state.
  const locked = useRef(new Set<string>());
  const [closed, setClosed] = useState(new Set<string>());
  const [message, setMessage] = useState<string | null>(props.permissionNotice ?? null);
  const active = connection.status.kind === "active";
  const visible = props.accounts.filter((a) =>
    props.tools.some((t) => {
      const state = controls[`${a.id}:${t.name}`];
      return state && state.phase !== "unconfirmed" && state.value;
    }),
  );
  const uncertain = Object.values(controls).some((s) => s.phase === "unconfirmed");
  const summary = (names: string[]) =>
    names.length ? (
      <>
        <span className="font-medium">{connection.name}</span> can see{" "}
        {new Intl.ListFormat("en", { style: "long", type: "conjunction" })
          .formatToParts(names)
          .map((part, i) => (
            <span key={i} className={part.type === "element" ? "font-medium" : undefined}>
              {part.value}
            </span>
          ))}
        .
      </>
    ) : (
      <span className="font-medium">{connection.name} can't see any of your accounts yet.</span>
    );
  const uncertainSummary = `Reload the page to confirm which accounts ${connection.name} can see.`;
  const save = async (
    account: Props["accounts"][number],
    tool: Props["tools"][number],
    wanted: boolean,
  ) => {
    const key = `${account.id}:${tool.name}`;
    const state = controls[key];
    if (!state || state.phase !== "confirmed" || state.value === wanted || locked.current.has(key))
      return;
    locked.current.add(key);
    setMessage(null);
    setControls((previous) => ({ ...previous, [key]: { ...state, phase: "saving" } }));
    const { outcome } = await postAction(`/connections/${connection.id}/permissions`, {
      account: account.id,
      tool: tool.name,
      allowed: String(wanted),
    });
    setControls((previous) => ({
      ...previous,
      [key]:
        outcome === "unknown"
          ? { phase: "unconfirmed" }
          : { phase: "confirmed", value: outcome === "ok" ? wanted : state.value },
    }));
    if (outcome !== "unknown") locked.current.delete(key);
    // Only Dismiss or the owner's next change clears a notice. A save that was already in flight
    // must not hide it; only "couldn't confirm", the one that warns of unknown access, replaces it.
    const notice = permissionMessage(outcome, connection.name);
    const uncertainNotice = permissionMessage("unknown", connection.name);
    if (notice) setMessage((current) => (current && notice !== uncertainNotice ? current : notice));
  };
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
              <section className="flex flex-col">
                <div className="flex max-w-2xl flex-col gap-1 pb-2">
                  <h2 className="text-base font-medium">Tool permissions</h2>
                  <p className="text-sm text-muted-foreground">
                    Choose which tools {connection.name} can use on each Google account.{" "}
                    {connection.name} sees an account only after you allow a tool on it. A change
                    applies to its next request.
                  </p>
                </div>
                {props.accounts.map((account) => {
                  const open = !closed.has(account.id);
                  const states = props.tools.map((t) => controls[`${account.id}:${t.name}`]!);
                  const word = states.some((s) => s.phase === "unconfirmed")
                    ? "Unconfirmed"
                    : states.some((s) => s.phase === "saving")
                      ? "Saving…"
                      : states.every((s) => s.phase !== "unconfirmed" && s.value)
                        ? "Allowed"
                        : "Not allowed";
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
                      className="border-b"
                    >
                      <div className="flex flex-col gap-1 py-4">
                        <div className="flex items-start justify-between gap-3">
                          <h3 className="min-w-0 flex-1">
                            <CollapsibleTrigger className="group/trigger flex items-start gap-2 rounded-sm text-left text-base font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                              <ChevronDownIcon className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]/trigger:-rotate-90" />
                              <span className="wrap-anywhere">
                                <span>{account.name}</span>
                                <Badge
                                  variant="outline"
                                  className="ml-2 align-middle font-normal text-muted-foreground"
                                >
                                  {props.tools.length}
                                  <span className="sr-only">
                                    {props.tools.length === 1 ? " tool" : " tools"}
                                  </span>
                                </Badge>
                              </span>
                            </CollapsibleTrigger>
                          </h3>
                          {!open && (
                            <span className="w-20 shrink-0 text-right text-sm text-muted-foreground">
                              {word}
                            </span>
                          )}
                        </div>
                        <p className="pl-6 text-sm wrap-anywhere text-muted-foreground">
                          {account.email}
                          {account.workspace && " · Workspace"}
                        </p>
                        {account.status.kind !== "ready" && (
                          <p className="max-w-2xl pt-1 pl-6 text-sm text-muted-foreground">
                            <AccountStatusText
                              account={account}
                              requiredGmailScopes={props.requiredGmailScopes}
                            />{" "}
                            If you allow a tool, {connection.name} sees this problem too.{" "}
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
                      <CollapsibleContent>
                        <ItemGroup className="gap-0">
                          {props.tools.map((tool) => (
                            <Item
                              key={tool.name}
                              className="flex-nowrap gap-3 rounded-none border-0 py-2 pr-0 pl-6"
                            >
                              <ItemContent className="min-w-0 gap-0.5">
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
                                  state={controls[`${account.id}:${tool.name}`]!}
                                  choose={(wanted) => void save(account, tool, wanted)}
                                />
                              </ItemActions>
                            </Item>
                          ))}
                        </ItemGroup>
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
  state,
  choose,
}: {
  label: string;
  state: ControlState;
  choose: (value: boolean) => void;
}) {
  const value = state.phase === "unconfirmed" ? "" : String(state.value);
  const blocked = state.phase !== "confirmed";
  return (
    <ToggleGroup
      type="single"
      role="radiogroup"
      aria-label={label}
      aria-busy={state.phase === "saving"}
      aria-disabled={blocked}
      value={value}
      size="lg"
      spacing={0.5}
      className={cn("shrink-0 rounded-lg bg-muted p-0.5", state.phase === "saving" && "opacity-50")}
      onValueChange={(next) => {
        if (!blocked && next) choose(next === "true");
      }}
    >
      {values.map((segment) => (
        <Tooltip key={segment.value}>
          <TooltipTrigger asChild>
            <ToggleGroupItem
              value={segment.value}
              role="radio"
              aria-label={segment.label}
              aria-checked={value === segment.value}
              aria-disabled={blocked}
              className={cn(
                "rounded-md text-muted-foreground hover:bg-transparent",
                segment.value === "true"
                  ? "aria-checked:bg-primary aria-checked:text-primary-foreground aria-checked:hover:bg-primary aria-checked:hover:text-primary-foreground"
                  : "aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-xs aria-checked:hover:bg-background",
              )}
              onClick={(event) => {
                if (blocked) event.preventDefault();
              }}
            >
              <segment.icon />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>{segment.label}</TooltipContent>
        </Tooltip>
      ))}
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
