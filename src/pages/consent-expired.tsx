import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StandalonePage } from "./standalone";
export function ConsentExpiredPage() {
  return (
    <StandalonePage>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-xl">
            <h1>This connection request expired</h1>
          </CardTitle>
          <CardDescription>
            It was already used, took longer than 10 minutes, or started in another browser. Nothing
            was connected. Start again from the app.
          </CardDescription>
        </CardHeader>
      </Card>
    </StandalonePage>
  );
}
