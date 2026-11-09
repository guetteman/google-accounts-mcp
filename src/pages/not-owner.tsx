import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Page } from "./page";
import { StandalonePage } from "./standalone";

export function NotOwnerPage({ address }: Extract<Page, { _tag: "NotOwner" }>) {
  return (
    <StandalonePage>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-xl font-semibold tracking-tight">
            <h1>This server belongs to someone else</h1>
          </CardTitle>
          <CardDescription>
            You signed in as <span className="font-medium text-foreground">{address}</span>, which
            doesn't own this server. Nothing changed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="w-full">
            <a href="/cdn-cgi/access/logout">Use a different account</a>
          </Button>
        </CardContent>
      </Card>
    </StandalonePage>
  );
}
