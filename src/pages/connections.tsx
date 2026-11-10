import { useState } from "react";
import { ChevronRightIcon, PlugIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
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

function status(c: ConnectionView) {
  return c.status.kind === "active"
    ? "Active"
    : `${c.status.kind === "revoked" ? "Revoked" : "Expired"} ${c.status.on}`;
}

export function ConnectionsPage({
  frame,
  connections,
  mcpUrl,
}: {
  readonly frame: Frame;
  readonly connections: ReadonlyArray<ConnectionView>;
  readonly mcpUrl: string;
}) {
  return (
    <OwnerFrame frame={frame}>
      <div className="flex flex-col gap-8">
        <PageHeader
          title="Connections"
          description="Apps that signed in to this server. Each starts with no access to your accounts. Open one to choose what it can use."
        />
        {connections.length === 0 ? (
          <ConnectionsEmpty mcpUrl={mcpUrl} />
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {["Name", "App", "Status", "Can see", "Last used"].map((title, i) => (
                      <TableHead
                        key={title}
                        className={cn("font-normal text-muted-foreground", i === 0 && "pl-0")}
                      >
                        {title}
                      </TableHead>
                    ))}
                    <TableHead>
                      <span className="sr-only">Open</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connections.map((c) => (
                    <TableRow
                      key={c.id}
                      className={cn(
                        "relative",
                        c.status.kind !== "active" && "text-muted-foreground",
                      )}
                    >
                      <TableCell
                        className={cn(
                          "max-w-56 py-4 pl-0 whitespace-normal wrap-anywhere",
                          c.status.kind === "active" && "font-medium",
                        )}
                      >
                        <a href={`/connections/${c.id}`} className="after:absolute after:inset-0">
                          {c.name}
                        </a>
                      </TableCell>
                      <TableCell>{c.appLabel}</TableCell>
                      <TableCell className="text-muted-foreground">{status(c)}</TableCell>
                      <TableCell className="max-w-56 whitespace-normal wrap-anywhere">
                        {c.canSee.join(", ") ||
                          (c.status.kind === "active" ? "No access yet" : "No access")}
                      </TableCell>
                      <TableCell>{c.lastUsed}</TableCell>
                      <TableCell className="pr-0 text-right">
                        <ChevronRightIcon className="ml-auto size-4 text-muted-foreground" />
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
                      <ItemGroup className="gap-0">
                        {rows.map((c, i) => (
                          <div key={c.id}>
                            {i > 0 && <ItemSeparator className="my-0" />}
                            <Item
                              className={cn(
                                "relative items-start border-0 px-0 py-4",
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
                                  <a
                                    href={`/connections/${c.id}`}
                                    className="after:absolute after:inset-0"
                                  >
                                    {c.name}
                                  </a>
                                </ItemTitle>
                                <ItemDescription className="line-clamp-none">
                                  {[
                                    ...(group === "ended" ? [status(c)] : []),
                                    ...(c.name !== c.appLabel ? [c.appLabel] : []),
                                    `Last used ${c.lastUsed}`,
                                  ].join(" · ")}
                                </ItemDescription>
                                {group === "active" && (
                                  <ItemDescription className="line-clamp-none wrap-anywhere text-foreground">
                                    {c.canSee.length
                                      ? `Can see ${c.canSee.join(", ")}`
                                      : "No access yet"}
                                  </ItemDescription>
                                )}
                              </ItemContent>
                              <ItemActions className="self-center text-muted-foreground">
                                <ChevronRightIcon className="size-4" />
                              </ItemActions>
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
    </OwnerFrame>
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
            className="font-mono text-xs md:text-xs"
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
