import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StandalonePage } from "./standalone";

export function MismatchPage() {
  return (
    <StandalonePage>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-xl font-semibold tracking-tight">
            <h1>This server's owner setting changed</h1>
          </CardTitle>
          <CardDescription>
            <code className="font-mono text-xs text-foreground">OWNER_EMAIL</code> no longer matches
            the account that owns this server, so the server refuses every request. Set it back to
            restore everything. To hand the server to a new owner, run{" "}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs whitespace-nowrap text-foreground">
              pnpm owner:reset
            </code>
            , which ends every connection and removes every account.
          </CardDescription>
        </CardHeader>
      </Card>
    </StandalonePage>
  );
}
