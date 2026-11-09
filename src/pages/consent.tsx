import { ShieldAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { Page } from "./page";
import { StandalonePage } from "./standalone";
export function ConsentPage({
  host,
  ownerEmail,
  client,
  handle,
  generation,
}: Extract<Page, { _tag: "Consent" }>) {
  return (
    <StandalonePage width="md">
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-xl font-semibold tracking-tight text-balance">
            <h1>
              {client.label} wants to connect to <span className="wrap-anywhere">{host}</span>
            </h1>
          </CardTitle>
          <CardDescription className="wrap-anywhere">Signed in as {ownerEmail}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action="/authorize" method="post" className="flex flex-col">
            <input type="hidden" name="handle" value={handle} />
            <input type="hidden" name="generation" value={generation} />
            <div className="flex flex-col gap-4 pt-4">
              <div className="flex flex-col gap-1">
                <p>
                  Access goes to{" "}
                  {client.local ? (
                    <>
                      an app on this computer (
                      <span className="font-medium">{client.callback.host}</span>)
                    </>
                  ) : (
                    <span className="font-medium">{client.callback.host}</span>
                  )}
                  .
                </p>
                <p className="font-mono text-xs text-muted-foreground wrap-anywhere">
                  {client.callback.href}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <p>
                  This connection gets{" "}
                  <span className="font-medium">no access to your Google accounts</span> until you
                  grant it on the Connections page.
                </p>
                <p className="text-pretty text-muted-foreground">
                  It stays connected until you revoke it or it goes unused for 90 days.
                </p>
              </div>
            </div>
            <div className="mt-8 flex flex-col gap-2">
              <Label htmlFor="connection-name">Connection name</Label>
              <Input
                id="connection-name"
                name="name"
                defaultValue={client.label}
                required
                maxLength={100}
                autoComplete="off"
              />
            </div>
            <Alert className="mt-6 border-0 bg-warning text-warning-foreground">
              <ShieldAlertIcon />
              <AlertTitle className="text-pretty">
                {client.local
                  ? "Continue only if you just started signing in from Claude Code on this computer."
                  : `Continue only if you just clicked Connect in ${client.label} yourself.`}
              </AlertTitle>
              <AlertDescription className="text-pretty text-warning-foreground">
                {client.local
                  ? "Any program on this computer can claim to be Claude Code. If you did not start this, close this page."
                  : "If someone sent you this link, close this page."}
              </AlertDescription>
            </Alert>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
              <Button type="submit" name="decision" value="approve">
                Connect
              </Button>
              <Button type="submit" name="decision" value="deny" formNoValidate variant="outline">
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </StandalonePage>
  );
}
