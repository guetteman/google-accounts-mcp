import { useState } from "react";
import { EllipsisIcon, PlugIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
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
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ConnectionView } from "../connections/model";
import { cn } from "@/lib/utils";
import { OwnerFrame, PageHeader } from "./frame";
import type { Frame } from "./page";
import { outcomeMessage, postConnectionAction } from "./connection-actions";

function status(c: ConnectionView) {
  return c.status.kind === "active"
    ? "Active"
    : `${c.status.kind === "revoked" ? "Revoked" : "Expired"} ${c.status.on}`;
}
type Action = "name" | "revoke";
export function ConnectionsPage({
  frame,
  connections,
  mcpUrl,
}: {
  readonly frame: Frame;
  readonly connections: ReadonlyArray<ConnectionView>;
  readonly mcpUrl: string;
}) {
  const [dialog, setDialog] = useState<{ connection: ConnectionView; action: Action } | null>(null);
  const menu = (c: ConnectionView) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground"
          aria-label={`Actions for ${c.name}`}
        >
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setDialog({ connection: c, action: "name" })}>
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => setDialog({ connection: c, action: "revoke" })}
        >
          Revoke
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <OwnerFrame frame={frame}>
      <div className="flex flex-col gap-8">
        <PageHeader
          title="Connections"
          description="Apps that signed in to this server. Each starts with no access to your accounts."
        />
        {connections.length === 0 ? (
          <ConnectionsEmpty mcpUrl={mcpUrl} />
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {["Name", "App", "Status", "Last used", "Created"].map((title, i) => (
                      <TableHead
                        key={title}
                        className={cn("font-normal text-muted-foreground", i === 0 && "pl-0")}
                      >
                        {title}
                      </TableHead>
                    ))}
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connections.map((c) => (
                    <TableRow
                      key={c.id}
                      className={cn(
                        "hover:bg-transparent",
                        c.status.kind !== "active" && "text-muted-foreground",
                      )}
                    >
                      <TableCell
                        className={cn(
                          "max-w-56 py-4 pl-0 whitespace-normal wrap-anywhere",
                          c.status.kind === "active" && "font-medium",
                        )}
                      >
                        {c.name}
                      </TableCell>
                      <TableCell>{c.appLabel}</TableCell>
                      <TableCell className="text-muted-foreground">{status(c)}</TableCell>
                      <TableCell>{c.lastUsed}</TableCell>
                      <TableCell>{c.created}</TableCell>
                      <TableCell className="pr-0 text-right">
                        {c.status.kind === "active" && menu(c)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-col gap-8 md:hidden">
              {["active", "ended"].map((group) => {
                const rows = connections.filter(
                  (c) => (c.status.kind === "active") === (group === "active"),
                );
                return (
                  rows.length > 0 && (
                    <section key={group} className="flex flex-col gap-2">
                      <h2 className="text-sm font-medium text-muted-foreground">
                        {group === "active" ? "Active" : "Ended"}
                      </h2>
                      <ItemGroup>
                        {rows.map((c, i) => (
                          <div key={c.id}>
                            {i > 0 && <ItemSeparator className="my-0" />}
                            <Item
                              className={cn(
                                "items-start border-0 px-0 py-4",
                                group === "ended" && "text-muted-foreground",
                              )}
                            >
                              <ItemContent className="min-w-0 gap-1">
                                <ItemTitle
                                  className={cn(
                                    "line-clamp-none wrap-anywhere",
                                    group === "active" ? "text-base" : "font-normal",
                                  )}
                                >
                                  {c.name}
                                </ItemTitle>
                                <ItemDescription className="line-clamp-none">
                                  {[
                                    ...(group === "ended" ? [status(c)] : []),
                                    ...(c.name !== c.appLabel ? [c.appLabel] : []),
                                    `Last used ${c.lastUsed}`,
                                    `Created ${c.created}`,
                                  ].join(" · ")}
                                </ItemDescription>
                              </ItemContent>
                              {group === "active" && (
                                <ItemActions className="-mt-1.5 -mr-2">{menu(c)}</ItemActions>
                              )}
                            </Item>
                          </div>
                        ))}
                      </ItemGroup>
                    </section>
                  )
                );
              })}
            </div>
          </>
        )}
      </div>
      {dialog && (
        <ConnectionDialog
          key={`${dialog.action}-${dialog.connection.id}`}
          {...dialog}
          close={() => setDialog(null)}
        />
      )}
    </OwnerFrame>
  );
}
function ConnectionDialog({
  connection,
  action,
  close,
}: {
  connection: ConnectionView;
  action: Action;
  close: () => void;
}) {
  const [name, setName] = useState(connection.name);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const outcome = await postConnectionAction(
      `/connections/${connection.id}/${action}`,
      action === "name" ? { name } : {},
    );
    if (outcome === "ok") {
      window.location.reload();
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
                maxLength={100}
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
            className="text-red-700 dark:text-red-300"
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
function ConnectionsEmpty({ mcpUrl }: { mcpUrl: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <Empty className="py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PlugIcon />
        </EmptyMedia>
        <EmptyTitle>No connections yet</EmptyTitle>
        <EmptyDescription>
          Add this server in Claude, Claude Code, or ChatGPT. Each app that signs in appears here.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex w-full flex-col gap-2 sm:flex-row">
          <Input
            readOnly
            value={mcpUrl}
            aria-label="MCP server URL"
            className="font-mono text-xs"
          />
          <Button
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(mcpUrl);
                setCopied(true);
                setFailed(false);
              } catch {
                setFailed(true);
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        {failed && (
          <p role="status" className="text-sm text-muted-foreground">
            Select the URL and copy it from the field.
          </p>
        )}
      </EmptyContent>
    </Empty>
  );
}
