"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Library, Loader2, LogOut } from "lucide-react";

/**
 * The Supabase browser client is ~70kB and this control renders on every page,
 * including the landing page where most visitors never sign in. Importing it
 * lazily keeps it out of the initial bundle; the button renders its loading
 * state until the client arrives, which it would do anyway while the session
 * check is in flight.
 */
let clientPromise: Promise<SupabaseClient> | null = null;

function getSupabase(): Promise<SupabaseClient> {
  if (!clientPromise) {
    clientPromise = import("@/lib/supabase/client").then((m) => m.createClient());
  }
  return clientPromise;
}

/**
 * Sign-in / sign-out control.
 *
 * Auth was fully plumbed — middleware, OAuth callback route, RLS policies, a
 * /library page — but no surface in the app ever called signInWithOAuth, so
 * there was no way to reach any of it. This is that missing surface.
 */
export function AuthButton() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    getSupabase().then(async (supabase) => {
      if (cancelled) return;

      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      setUser(data.user ?? null);
      setLoading(false);

      // Keeps the header in sync after the OAuth redirect lands, and across tabs.
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        setUser(session?.user ?? null);
        setLoading(false);
      });
      unsubscribe = () => subscription.unsubscribe();
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const signIn = useCallback(async () => {
    setWorking(true);
    const supabase = await getSupabase();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        // Round-trips through /api/auth/callback, which exchanges the code for
        // a session cookie and then returns the user to where they started.
        redirectTo: `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(
          window.location.pathname
        )}`,
      },
    });
    if (error) setWorking(false);
  }, []);

  const signOut = useCallback(async () => {
    setWorking(true);
    const supabase = await getSupabase();
    await supabase.auth.signOut();
    setUser(null);
    setWorking(false);
    router.refresh();
  }, [router]);

  if (loading) {
    return <div className="h-8 w-20 rounded-md bg-muted/40 animate-pulse" />;
  }

  if (!user) {
    return (
      <Button size="sm" variant="outline" onClick={signIn} disabled={working}>
        {working ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
        Sign in
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {/* A plain styled link rather than a Button wrapper — this Button has no
          Radix `asChild`, so nesting an anchor inside it would be invalid. */}
      <Link
        href="/library"
        className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <Library className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">My Moments</span>
      </Link>
      <Button
        size="icon"
        variant="ghost"
        onClick={signOut}
        disabled={working}
        title={`Sign out (${user.email ?? "signed in"})`}
        className="h-8 w-8"
      >
        {working ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <LogOut className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}
