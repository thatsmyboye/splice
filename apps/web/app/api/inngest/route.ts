import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { analyzeTrack, handleAnalysisFailure } from "@/inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [analyzeTrack, handleAnalysisFailure],
});
