import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StandalonePage } from "./standalone";

export function AccessUnavailablePage() {
  return (
    <StandalonePage>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-xl font-semibold tracking-tight">
            <h1>Cloudflare Access didn't answer</h1>
          </CardTitle>
          <CardDescription>Nothing changed. Reload this page in a minute.</CardDescription>
        </CardHeader>
      </Card>
    </StandalonePage>
  );
}
