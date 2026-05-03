import type { MomentDescriptor, SourceAnalysis } from "@splice/types";

interface DescriptorDimension {
  label: string;
  value: number;
  lowLabel: string;
  highLabel: string;
  displayLabel: string;
}

function buildDimensions(d: MomentDescriptor): DescriptorDimension[] {
  return [
    {
      label: "Energy",
      value: d.energy_profile,
      lowLabel: "minimal",
      highLabel: "intense",
      displayLabel: d.energy_profile_label,
    },
    {
      label: "Timbre",
      value: d.timbral_character,
      lowLabel: "warm",
      highLabel: "bright",
      displayLabel: d.timbral_character_label,
    },
    {
      label: "Harmonic tension",
      value: d.harmonic_tension,
      lowLabel: "resolved",
      highLabel: "tense",
      displayLabel: d.harmonic_tension_label,
    },
    {
      label: "Structure",
      value: d.structural_position,
      lowLabel: "intro/outro",
      highLabel: "climax",
      displayLabel: d.structural_position_label,
    },
    {
      label: "Texture",
      value: d.textural_density,
      lowLabel: "sparse",
      highLabel: "dense",
      displayLabel: d.textural_density_label,
    },
    {
      label: "Emotional arc",
      value: d.emotional_arc,
      lowLabel: "melancholic",
      highLabel: "euphoric",
      displayLabel: d.emotional_arc_label,
    },
  ];
}

interface MomentAnalysisPanelProps {
  descriptor: MomentDescriptor;
  sourceAnalysis: SourceAnalysis | null;
}

export function MomentAnalysisPanel({ descriptor, sourceAnalysis }: MomentAnalysisPanelProps) {
  const dimensions = buildDimensions(descriptor);
  const hasHarmonic =
    sourceAnalysis &&
    (sourceAnalysis.key_name || sourceAnalysis.bpm || sourceAnalysis.time_signature || sourceAnalysis.chord_label);

  const keyLabel = sourceAnalysis?.key_name
    ? sourceAnalysis.key_mode === "minor"
      ? `${sourceAnalysis.key_name}m`
      : sourceAnalysis.key_name
    : null;

  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-4">
      {/* Descriptor reasoning */}
      <p className="text-sm text-muted-foreground leading-snug">
        <span className="font-medium text-foreground">Moment interpreted: </span>
        {descriptor.reasoning}
      </p>

      {/* Descriptor dimensions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
        {dimensions.map((dim) => (
          <div key={dim.label} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{dim.label}</span>
              <span className="text-foreground/80 font-medium">{dim.displayLabel}</span>
            </div>
            <div className="relative h-1.5 rounded-full bg-border overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-primary/70"
                style={{ width: `${Math.round(dim.value * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Source track harmonic data */}
      {hasHarmonic && (
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/50">
          <span className="text-xs text-muted-foreground">Source key/meter:</span>
          {keyLabel && (
            <span className="text-xs font-mono bg-secondary border border-border px-2 py-0.5 rounded">
              {keyLabel}
            </span>
          )}
          {sourceAnalysis?.time_signature && (
            <span className="text-xs font-mono bg-secondary border border-border px-2 py-0.5 rounded">
              {sourceAnalysis.time_signature}/4
            </span>
          )}
          {sourceAnalysis?.chord_label && (
            <span className="text-xs font-mono bg-secondary border border-border px-2 py-0.5 rounded">
              {sourceAnalysis.chord_label}
            </span>
          )}
          {sourceAnalysis?.bpm && (
            <span className="text-xs font-mono text-muted-foreground">
              {Math.round(sourceAnalysis.bpm)} BPM
            </span>
          )}
        </div>
      )}
    </div>
  );
}
