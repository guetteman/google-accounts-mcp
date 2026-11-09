import type { ReactNode } from "react";
import { PRODUCT } from "./page";

export function StandalonePage({
  children,
  width = "sm",
}: {
  readonly children: ReactNode;
  readonly width?: "sm" | "md";
}) {
  return (
    <main className="flex min-h-svh flex-col items-center bg-muted px-4 py-8 sm:py-12 md:py-16">
      <div className={`flex w-full flex-col gap-4 ${width === "md" ? "max-w-md" : "max-w-sm"}`}>
        <div className="flex items-baseline gap-2 px-1 text-sm">
          <span className="font-semibold tracking-tight">{PRODUCT}</span>
        </div>
        {children}
      </div>
    </main>
  );
}
