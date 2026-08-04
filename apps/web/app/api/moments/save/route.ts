import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * Saves (or unsaves) a moment to the signed-in user's library.
 *
 * Moments are created by /api/interpret with `is_saved: false` — they start as
 * transient search inputs. Nothing ever flipped that flag, so /library was
 * empty by construction no matter what the user did. This is the missing
 * write.
 *
 * Anonymous searches produce moments with a null user_id. Signing in
 * afterwards and saving claims the moment, so the common path (search first,
 * sign in when you want to keep it) works without losing the moment.
 */

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

const RequestSchema = z.object({
  momentId: z.string().uuid(),
  saved: z.boolean().default(true),
  title: z.string().trim().min(1).max(120).optional(),
});

export async function POST(request: NextRequest) {
  const supabase = createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Sign in to save moments" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { momentId, saved, title } = parsed.data;
  const serviceSupabase = getServiceClient();

  const { data: moment } = await serviceSupabase
    .from("moments")
    .select("id, user_id")
    .eq("id", momentId)
    .single();

  if (!moment) {
    return NextResponse.json({ error: "Moment not found" }, { status: 404 });
  }

  // Claiming is allowed only for unowned moments. A moment belonging to
  // someone else is off limits even though the caller is authenticated.
  if (moment.user_id && moment.user_id !== user.id) {
    return NextResponse.json({ error: "Not your moment" }, { status: 403 });
  }

  const { error } = await serviceSupabase
    .from("moments")
    .update({
      user_id: user.id,
      is_saved: saved,
      ...(title ? { title } : {}),
    })
    .eq("id", momentId);

  if (error) {
    console.error("[moments/save] update failed", error);
    return NextResponse.json({ error: "Could not save moment" }, { status: 500 });
  }

  return NextResponse.json({ saved });
}
