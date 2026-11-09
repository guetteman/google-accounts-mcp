import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StandalonePage } from "./standalone";
export function ClientRefusedPage() {
  return (
    <StandalonePage>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-xl">
            <h1>This app can't connect</h1>
          </CardTitle>
          <CardDescription>
            Only Claude, Claude Code, and ChatGPT can connect to this server. Nothing changed.
          </CardDescription>
        </CardHeader>
      </Card>
    </StandalonePage>
  );
}
