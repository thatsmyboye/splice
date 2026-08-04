import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuthButton } from "@/components/auth/AuthButton";

interface SiteHeaderProps {
  /** Renders a back arrow to this path. Omit on the landing page. */
  backHref?: string;
  /** Defaults to the wordmark. */
  title?: string;
}

/**
 * Shared app header. Previously each page rolled its own, and none of them
 * carried the auth control — which is why signing in was unreachable.
 */
export function SiteHeader({ backHref, title }: SiteHeaderProps) {
  return (
    <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-border bg-background/80 px-4 py-3 backdrop-blur-sm">
      {backHref && (
        <Link
          href={backHref}
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
      )}
      <Link href="/" className="text-lg font-semibold tracking-tight">
        {title ?? "splice"}
      </Link>
      <div className="ml-auto">
        <AuthButton />
      </div>
    </header>
  );
}
