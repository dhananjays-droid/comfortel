import { Ruler } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
import { ASSUMED, CLEARANCE } from "@/lib/layout";
import { genericCapacity, toCm, validate, type RoomSpec, type Unit } from "@/lib/room";
import { cn } from "@/lib/utils";

/**
 * "Tell us the room, we'll tell you what fits."
 *
 * Three fields, two of them optional, because the only number most people
 * actually know is the wall they want chairs along. It answers live rather than
 * on submit — watching the station count change as you type the wall length is
 * the whole point, and it means nobody submits a units mistake without seeing
 * an absurd answer first.
 */
export function RoomSpecDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (spec: RoomSpec) => void;
}) {
  const [unit, setUnit] = useState<Unit>("ft");
  const [wall, setWall] = useState("");
  const [depth, setDepth] = useState("");
  const [stations, setStations] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) return;
    setWall("");
    setDepth("");
    setStations("");
    setTouched(false);
    // The unit is deliberately kept — someone who thinks in feet still does the
    // second time they open this.
  }, [open]);

  const num = (raw: string): number | undefined => {
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };

  const spec = useMemo((): RoomSpec | null => {
    const w = num(wall);
    if (w === undefined) return null;
    const d = num(depth);
    const s = num(stations);
    return {
      wallCm: toCm(w, unit),
      ...(d === undefined ? {} : { depthCm: toCm(d, unit) }),
      ...(s === undefined ? {} : { stations: Math.round(s) }),
      unit,
    };
  }, [wall, depth, stations, unit]);

  const errors = validate(
    spec ?? {
      unit,
      ...(num(depth) === undefined ? {} : { depthCm: toCm(num(depth) as number, unit) }),
    },
  );
  const errorFor = (field: "wall" | "depth" | "stations") =>
    touched ? errors.find((e) => e.field === field)?.message : undefined;

  const fit = spec && !errors.length ? genericCapacity(spec) : null;

  function submit() {
    setTouched(true);
    if (!spec || errors.length) return;
    onSubmit(spec);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Ruler className="h-4 w-4 text-ink-2" />
            Plan by dimensions
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-ink-3">
            Give us the wall your styling chairs run along and we&apos;ll work out how many stations
            fit — then suggest pieces to match.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-sm text-ink-2">Measuring in</Label>
            <div
              role="radiogroup"
              aria-label="Unit"
              className="flex items-center gap-1 rounded-lg bg-muted p-0.5"
            >
              {(["ft", "m"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  role="radio"
                  aria-checked={unit === u}
                  onClick={() => setUnit(u)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    unit === u ? "bg-surface2 text-ink-1 shadow-sm" : "text-ink-3 hover:text-ink-1",
                  )}
                >
                  {u === "ft" ? "Feet" : "Metres"}
                </button>
              ))}
            </div>
          </div>

          <Field
            id="room-wall"
            label="Styling wall length"
            hint="The wall the chairs sit along"
            unit={unit}
            value={wall}
            onChange={setWall}
            error={errorFor("wall")}
            autoFocus
          />

          <Field
            id="room-depth"
            label="Room depth"
            hint="Optional — how far the room runs back"
            unit={unit}
            value={depth}
            onChange={setDepth}
            error={errorFor("depth")}
          />

          <Field
            id="room-stations"
            label="Stations you want"
            hint="Optional — we'll tell you if it's tight"
            unit="stations"
            value={stations}
            onChange={setStations}
            error={errorFor("stations")}
          />

          {/* Answers while they type: the reason this is a form and not a chat turn. */}
          {fit ? (
            <div className="rounded-xl border border-border bg-surface2 p-3">
              <p className="text-sm text-ink-1">
                {fit.fits > 0 ? (
                  <>
                    That wall takes{" "}
                    <span className="font-semibold">
                      {fit.fits} station{fit.fits === 1 ? "" : "s"}
                    </span>
                    .
                  </>
                ) : (
                  "That wall is too short for a full station."
                )}
              </p>
              {fit.warnings.map((warning) => (
                <p key={warning} className="mt-1.5 text-xs leading-snug text-ink-3">
                  {warning}
                </p>
              ))}
              <p className="mt-1.5 text-[11px] leading-snug text-ink-4">
                Planned at a typical {ASSUMED.stationWidth}cm station with{" "}
                {CLEARANCE.betweenStations}cm between chairs. Trade convention, not building code —
                tell us if you work to different clearances.
              </p>
            </div>
          ) : null}
        </div>

        <div className="mt-1 flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={onClose}
            className="text-ink-3 hover:bg-muted hover:text-ink-1"
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!spec || errors.length > 0}
            className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary-strong"
          >
            Suggest pieces
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  hint,
  unit,
  value,
  onChange,
  error,
  autoFocus,
}: {
  id: string;
  label: string;
  hint: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
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
          step="0.1"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={Boolean(error)}
          {...(error ? { "aria-describedby": `${id}-error` } : {})}
          className={cn("pr-16", error && "border-destructive")}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-4">
          {unit}
        </span>
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
