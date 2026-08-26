import { ArrowLeft, Check, Loader2, Ruler, Sparkles, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatPrice } from "@/lib/catalog";
import { BRIEF_PLACEHOLDER, BRIEF_PROMPTS, readBrief } from "@/lib/brief";
import { ASSUMED, CLEARANCE } from "@/lib/layout";
import { TIER_LABEL, buildPackages, needsFor, type Package } from "@/lib/packages";
import { curatePackages } from "@/lib/curate.functions";
import { formatLength, genericCapacity, toCm, type Unit } from "@/lib/room";
import { cn } from "@/lib/utils";

/**
 * The guided way in: say what you want, see what it costs, pick one.
 *
 * All three starters land here because they are the same question asked three
 * ways, and each one used to dump a raw sentence into the chat and hope. Guided
 * selling works the other way round — gather the requirement first, narrow the
 * options with it, and only then recommend — so this asks, shows its working,
 * and lets the numbers be corrected before anything is proposed.
 */

export type WizardMode = "brief" | "budget" | "dimensions";

export type WizardResult = {
  pkg: Package;
  stations: number;
  budget: number;
  /** What the customer said, replayed to the model for the taste half. */
  note: string;
  /** Dimensions runs end in one image per zone rather than a single frame. */
  byZone: boolean;
};

const TITLE: Record<WizardMode, string> = {
  brief: "Tell us about the salon",
  budget: "Design to a budget",
  dimensions: "Plan by dimensions",
};

const BLURB: Record<WizardMode, string> = {
  brief: "A sentence or two is plenty. The more you say, the closer the first pass lands.",
  budget: "Give us a number and we'll build three ways to spend it.",
  dimensions: "Give us the room and we'll work out what fits, then furnish it.",
};

const ICON: Record<WizardMode, typeof Wallet> = {
  brief: Sparkles,
  budget: Wallet,
  dimensions: Ruler,
};

/** A sane opening bid, so the packages step is never empty on arrival. */
const DEFAULT_BUDGET = 15000;
const DEFAULT_STATIONS = 4;

export function PlanWizard({
  mode,
  open,
  onClose,
  onChoose,
}: {
  mode: WizardMode | null;
  open: boolean;
  onClose: () => void;
  onChoose: (result: WizardResult) => void;
}) {
  const [step, setStep] = useState<"ask" | "choose">("ask");
  const [note, setNote] = useState("");
  const [stations, setStations] = useState(String(DEFAULT_STATIONS));
  const [budget, setBudget] = useState(String(DEFAULT_BUDGET));
  const [unit, setUnit] = useState<Unit>("ft");
  const [wall, setWall] = useState("");
  const [depth, setDepth] = useState("");

  useEffect(() => {
    if (open) return;
    setStep("ask");
    setNote("");
    setWall("");
    setDepth("");
    setStations(String(DEFAULT_STATIONS));
    setBudget(String(DEFAULT_BUDGET));
  }, [open]);

  // What the description gave us, so the fields can show it back rather than
  // asking again for something already typed.
  const parsed = useMemo(() => readBrief(note), [note]);

  useEffect(() => {
    if (parsed.stations) setStations(String(parsed.stations));
    if (parsed.budget) setBudget(String(parsed.budget));
  }, [parsed.stations, parsed.budget]);

  const wallCm = Number.parseFloat(wall) > 0 ? toCm(Number.parseFloat(wall), unit) : 0;
  const depthCm = Number.parseFloat(depth) > 0 ? toCm(Number.parseFloat(depth), unit) : 0;

  const fits = useMemo(() => {
    if (!wallCm) return null;
    return genericCapacity({
      wallCm,
      ...(depthCm ? { depthCm } : {}),
      unit,
    });
  }, [wallCm, depthCm, unit]);

  // Dimensions decide the station count; the other modes are told it.
  const effectiveStations =
    mode === "dimensions"
      ? (fits?.fits ?? 0)
      : Math.max(1, Math.min(20, Number.parseInt(stations, 10) || DEFAULT_STATIONS));

  const effectiveBudget = Math.max(
    500,
    Number.parseFloat(budget.replace(/[^\d.]/g, "")) || DEFAULT_BUDGET,
  );

  /**
   * Packages come from the model where possible and from the deterministic
   * packer otherwise. Held in state rather than derived, because the good
   * version is a round trip — and the fallback is computed locally so the step
   * is never empty even with no network.
   */
  const [packages, setPackages] = useState<Package[]>([]);
  const [loading, setLoading] = useState(false);
  const [curated, setCurated] = useState(true);
  const curate = useServerFn(curatePackages);

  async function showOptions() {
    if (effectiveStations < 1) return;
    setStep("choose");
    setLoading(true);
    // Seed with the local packer so there is something real on screen while the
    // request is out, and something correct if it never comes back.
    setPackages(buildPackages(effectiveBudget, needsFor(effectiveStations)));
    setCurated(true);
    try {
      const result = await curate({
        data: { brief: note.trim(), stations: effectiveStations, budget: effectiveBudget },
      });
      setPackages(result.packages);
      setCurated(result.curated);
    } catch {
      setCurated(false);
    } finally {
      setLoading(false);
    }
  }

  if (!mode) return null;
  const Icon = ICON[mode];

  const canContinue =
    mode === "dimensions" ? effectiveStations > 0 : effectiveStations > 0 && effectiveBudget > 0;

  function choose(pkg: Package) {
    onChoose({
      pkg,
      stations: effectiveStations,
      budget: effectiveBudget,
      note: note.trim(),
      byZone: mode === "dimensions",
    });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[88dvh] max-w-[640px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {step === "choose" ? (
              <button
                type="button"
                onClick={() => setStep("ask")}
                aria-label="Back"
                className="-ml-1 rounded p-1 text-ink-3 transition-colors hover:bg-muted hover:text-ink-1"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            ) : (
              <Icon className="h-4 w-4 text-ink-2" />
            )}
            {step === "ask" ? TITLE[mode] : "Three ways to do it"}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-ink-3">
            {step === "ask"
              ? BLURB[mode]
              : `${effectiveStations} station${effectiveStations === 1 ? "" : "s"} against ${formatPrice(effectiveBudget)}. Every option below is the most you can get at its price.`}
          </DialogDescription>
        </DialogHeader>

        {step === "ask" ? (
          <div className="space-y-4">
            {mode === "brief" ? (
              <div className="space-y-2">
                <Label htmlFor="brief" className="text-sm text-ink-2">
                  What are you fitting out?
                </Label>
                <Textarea
                  id="brief"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={BRIEF_PLACEHOLDER}
                  rows={4}
                  className="resize-none text-sm leading-relaxed"
                />
                <div className="flex flex-wrap gap-1.5">
                  {BRIEF_PROMPTS.map((prompt) => (
                    <span
                      key={prompt}
                      className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-ink-3"
                    >
                      {prompt}
                    </span>
                  ))}
                </div>
                {parsed.stations || parsed.budget ? (
                  <p className="flex items-center gap-1.5 text-xs text-ink-3">
                    <Check className="h-3.5 w-3.5 text-ink-2" />
                    Read from that:{" "}
                    {[
                      parsed.stations ? `${parsed.stations} stations` : null,
                      parsed.budget ? formatPrice(parsed.budget) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    . Correct it below if that's wrong.
                  </p>
                ) : null}
              </div>
            ) : null}

            {mode === "dimensions" ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <Label className="text-sm text-ink-2">Measuring in</Label>
                  <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
                    {(["ft", "m"] as const).map((u) => (
                      <button
                        key={u}
                        type="button"
                        onClick={() => setUnit(u)}
                        aria-pressed={unit === u}
                        className={cn(
                          "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                          unit === u ? "bg-surface2 text-ink-1 shadow-sm" : "text-ink-3",
                        )}
                      >
                        {u === "ft" ? "Feet" : "Metres"}
                      </button>
                    ))}
                  </div>
                </div>
                <Num
                  id="wiz-wall"
                  label="Styling wall length"
                  hint="The wall the chairs sit along"
                  unit={unit}
                  value={wall}
                  onChange={setWall}
                  autoFocus
                />
                <Num
                  id="wiz-depth"
                  label="Room depth"
                  hint="Optional"
                  unit={unit}
                  value={depth}
                  onChange={setDepth}
                />
                {fits ? (
                  <div className="rounded-xl border border-border bg-surface2 p-3">
                    <p className="text-sm text-ink-1">
                      {fits.fits > 0 ? (
                        <>
                          That wall takes <span className="font-semibold">{fits.fits}</span> station
                          {fits.fits === 1 ? "" : "s"}.
                        </>
                      ) : (
                        "That wall is too short for a full station."
                      )}
                    </p>
                    {fits.warnings.map((w) => (
                      <p key={w} className="mt-1.5 text-xs leading-snug text-ink-3">
                        {w}
                      </p>
                    ))}
                    <p className="mt-1.5 text-[11px] leading-snug text-ink-4">
                      At a typical {ASSUMED.stationWidth}cm station with {CLEARANCE.betweenStations}
                      cm between chairs. Trade convention, not building code.
                    </p>
                  </div>
                ) : null}
              </>
            ) : null}

            {mode !== "dimensions" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Num
                  id="wiz-stations"
                  label="Styling stations"
                  hint="How many chairs"
                  unit="stations"
                  value={stations}
                  onChange={setStations}
                  autoFocus={mode === "budget"}
                />
                <Num
                  id="wiz-budget"
                  label="Budget"
                  hint="Furniture only"
                  unit="USD"
                  value={budget}
                  onChange={setBudget}
                />
              </div>
            ) : (
              <Num
                id="wiz-budget-dims"
                label="Budget"
                hint="Optional — shapes what we pick"
                unit="USD"
                value={budget}
                onChange={setBudget}
              />
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={onClose} className="text-ink-3 hover:bg-muted">
                Cancel
              </Button>
              <Button
                onClick={() => void showOptions()}
                disabled={!canContinue}
                className="bg-primary text-primary-foreground hover:bg-primary-strong"
              >
                Show me options
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            {loading ? (
              <p className="flex items-center gap-2 text-xs text-ink-3">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Choosing pieces that go together…
              </p>
            ) : null}
            {packages.map((pkg) => (
              <PackageCard
                key={pkg.tier}
                pkg={pkg}
                budget={effectiveBudget}
                onChoose={() => choose(pkg)}
              />
            ))}
            <p className="pt-1 text-[11px] leading-snug text-ink-4">
              Furniture only — delivery, installation and plumbing aren&apos;t included. Prices are
              current catalogue prices.
              {!loading && !curated
                ? " Matched on catalogue rules this time — the assistant wasn't reachable, so these are picked by price band rather than by look."
                : null}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PackageCard({
  pkg,
  budget,
  onChoose,
}: {
  pkg: Package;
  budget: number;
  onChoose: () => void;
}) {
  const middle = pkg.tier === "balanced";

  return (
    <div
      className={cn(
        "rounded-xl border p-3.5 transition-colors",
        middle ? "border-ink-1 bg-surface2" : "border-border bg-surface2/60",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-ink-1">
          {TIER_LABEL[pkg.tier]}
          {middle ? (
            <span className="ml-2 rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-1">
              Closest fit
            </span>
          ) : null}
        </p>
        <p className="shrink-0 text-sm font-semibold text-ink-1">{formatPrice(pkg.total)}</p>
      </div>

      <ul className="mt-2 space-y-1">
        {pkg.reasons.map((reason) => (
          <li key={reason} className="text-xs leading-snug text-ink-3">
            {reason}
          </li>
        ))}
      </ul>

      <details className="mt-2 group">
        <summary className="cursor-pointer list-none text-[11px] text-ink-4 underline-offset-2 hover:text-ink-2 hover:underline">
          {pkg.lines.reduce((n, l) => n + l.qty, 0)} pieces — see the list
        </summary>
        <ul className="mt-1.5 space-y-0.5 border-t border-border pt-1.5">
          {pkg.lines.map((line) => (
            <li key={line.role} className="flex justify-between gap-3 text-[11px] text-ink-3">
              <span className="min-w-0 truncate">
                {line.qty} × {line.product.name}
              </span>
              <span className="shrink-0 tabular-nums">{formatPrice(line.subtotal)}</span>
            </li>
          ))}
        </ul>
      </details>

      <Button
        size="sm"
        onClick={onChoose}
        variant={middle ? "default" : "outline"}
        className={cn(
          "mt-2.5 h-8 w-full text-xs font-medium shadow-none",
          middle
            ? "bg-primary text-primary-foreground hover:bg-primary-strong"
            : "border-border bg-transparent text-ink-1 hover:bg-muted",
        )}
      >
        {pkg.total > budget ? "Take the stretch" : "Use this one"}
      </Button>
    </div>
  );
}

function Num({
  id,
  label,
  hint,
  unit,
  value,
  onChange,
  autoFocus,
}: {
  id: string;
  label: string;
  hint: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id} className="text-sm text-ink-2">
          {label}
        </Label>
        <span className="text-[11px] text-ink-4">{hint}</span>
      </div>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          className="pr-16"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-4">
          {unit}
        </span>
      </div>
    </div>
  );
}
