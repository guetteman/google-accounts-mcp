import type { ReactNode } from "react";
import { ChevronsUpDownIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { PRODUCT, type Frame } from "./page";

export function OwnerFrame({
  frame,
  children,
}: {
  readonly frame: Frame;
  readonly children: ReactNode;
}) {
  return (
    <SidebarProvider>
      <AppSidebar frame={frame} />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4 md:hidden">
          <SidebarTrigger />
          <span className="text-sm font-semibold tracking-tight">{PRODUCT}</span>
        </header>
        <div className="w-full max-w-4xl px-4 pt-6 pb-24 sm:px-6 md:px-12 md:pt-12">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function AppSidebar({ frame }: { readonly frame: Frame }) {
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="px-4 pt-6 pb-4">
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold tracking-tight">{PRODUCT}</div>
          <div className="truncate text-xs text-muted-foreground">{frame.host}</div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {(["accounts", "connections", "activity"] as const).map((page) => (
                <SidebarMenuItem key={page}>
                  <SidebarMenuButton asChild isActive={frame.current === page}>
                    <a href={`/${page}`} aria-current={frame.current === page ? "page" : undefined}>
                      {page === "accounts"
                        ? "Accounts"
                        : page === "connections"
                          ? "Connections"
                          : "Activity"}
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-2">
        <OwnerMenu email={frame.ownerEmail} />
      </SidebarFooter>
    </Sidebar>
  );
}

function OwnerMenu({ email }: { readonly email: string }) {
  const { isMobile } = useSidebar();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton aria-label="Owner account" className="text-muted-foreground">
              <span className="min-w-0 flex-1 truncate text-left">{email}</span>
              <ChevronsUpDownIcon className="size-4 shrink-0" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side={isMobile ? "bottom" : "top"} align="start" className="w-56">
            <DropdownMenuItem asChild>
              <a href="/cdn-cgi/access/logout">Sign out</a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function PageHeader({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="flex max-w-2xl flex-col gap-1">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
