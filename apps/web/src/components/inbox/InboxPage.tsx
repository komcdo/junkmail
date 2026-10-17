import { InboxIcon } from "lucide-react";

import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset, useSidebar } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

/**
 * At /inbox the inbox sidebar fills the window and this page is hidden. It shows only when
 * the sidebar is collapsed, or on narrow screens where the sidebar is a sheet.
 */
export function InboxPage() {
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InboxIcon />
          </EmptyMedia>
          <EmptyTitle>Inbox is hidden</EmptyTitle>
          <EmptyDescription>Show the sidebar to see your work.</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" onClick={() => (isMobile ? setOpenMobile(true) : setOpen(true))}>
          Show inbox
        </Button>
      </Empty>
    </SidebarInset>
  );
}
