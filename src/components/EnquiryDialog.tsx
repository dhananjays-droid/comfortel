import { useServerFn } from "@tanstack/react-start";
import { Loader2, Minus, Plus, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

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
import { formatPrice, type FullProduct } from "@/lib/catalog";
import { submitEnquiry } from "@/lib/enquiry.functions";

export type EnquiryTarget = {
  product: FullProduct;
  /** A render the customer produced for this piece, attached to the enquiry. */
  visualizationUrl?: string | undefined;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function EnquiryDialog({
  target,
  open,
  onClose,
  onSubmitted,
}: {
  target: EnquiryTarget | null;
  open: boolean;
  onClose: () => void;
  onSubmitted: (result: { reference: string; product: FullProduct }) => void;
}) {
  const send = useServerFn(submitEnquiry);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) return;
    setQuantity(1);
    setNotes("");
    setSubmitting(false);
    setError(null);
    setTouched(false);
    // Name, email, phone and business deliberately persist across the dialog
    // being reopened — a salon owner enquiring about three chairs should not
    // retype their details three times in one session.
  }, [open]);

  if (!target) return null;
  const { product, visualizationUrl } = target;

  const nameError = touched && fullName.trim().length < 2 ? "Please enter your name." : null;
  const emailError = touched && !EMAIL.test(email.trim()) ? "Please enter a valid email." : null;
  const valid = fullName.trim().length >= 2 && EMAIL.test(email.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await send({
        data: {
          productId: product.id,
          fullName: fullName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          businessName: businessName.trim(),
          quantity,
          notes: notes.trim(),
          visualizationUrl,
        },
      });
      onSubmitted({ reference: result.reference, product });
    } catch {
      setError("We couldn't send that just now. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[92vh] overflow-y-auto border-border bg-surface2 sm:max-w-[520px]">
        <DialogHeader className="space-y-3">
          <DialogTitle className="pr-6 text-left text-base font-semibold text-ink-1">
            Request a quote
          </DialogTitle>
          <DialogDescription className="text-left text-sm text-ink-3">
            Send your details and the Comfortel team will come back with pricing, lead time and
            freight.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted p-3">
          {product.images?.[0] ? (
            <img
              src={product.images[0]}
              alt=""
              className="h-12 w-12 shrink-0 rounded-lg border border-border object-cover"
            />
          ) : null}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink-1">{product.name}</p>
            <p className="text-sm text-ink-3">{formatPrice(product.price)} each</p>
          </div>
        </div>

        {visualizationUrl ? (
          <p className="flex items-center gap-2 text-xs text-ink-3">
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            Your render of this piece will be attached to the enquiry.
          </p>
        ) : null}

        <form className="space-y-4" onSubmit={submit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="enq-name" label="Your name" error={nameError}>
              <Input
                id="enq-name"
                value={fullName}
                autoComplete="name"
                onChange={(e) => setFullName(e.target.value)}
                className="border-border bg-surface2"
              />
            </Field>
            <Field id="enq-email" label="Email" error={emailError}>
              <Input
                id="enq-email"
                type="email"
                value={email}
                autoComplete="email"
                onChange={(e) => setEmail(e.target.value)}
                className="border-border bg-surface2"
              />
            </Field>
            <Field id="enq-phone" label="Phone" optional>
              <Input
                id="enq-phone"
                type="tel"
                value={phone}
                autoComplete="tel"
                onChange={(e) => setPhone(e.target.value)}
                className="border-border bg-surface2"
              />
            </Field>
            <Field id="enq-business" label="Salon or business" optional>
              <Input
                id="enq-business"
                value={businessName}
                autoComplete="organization"
                onChange={(e) => setBusinessName(e.target.value)}
                className="border-border bg-surface2"
              />
            </Field>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-ink-2">How many?</Label>
            <div className="flex items-center gap-1">
              <Stepper
                label="Decrease quantity"
                disabled={quantity <= 1}
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              >
                <Minus className="h-3.5 w-3.5" />
              </Stepper>
              <span className="w-12 text-center text-sm font-medium tabular-nums text-ink-1">
                {quantity}
              </span>
              <Stepper
                label="Increase quantity"
                disabled={quantity >= 99}
                onClick={() => setQuantity((q) => Math.min(99, q + 1))}
              >
                <Plus className="h-3.5 w-3.5" />
              </Stepper>
              {product.price ? (
                <span className="ml-3 text-sm text-ink-3">
                  {formatPrice(product.price * quantity)} at list
                </span>
              ) : null}
            </div>
          </div>

          <Field id="enq-notes" label="Anything else" optional>
            <Textarea
              id="enq-notes"
              rows={3}
              value={notes}
              placeholder="Colour preference, delivery window, how many stations you're fitting out..."
              onChange={(e) => setNotes(e.target.value)}
              className="resize-none border-border bg-surface2 placeholder:text-ink-4"
            />
          </Field>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="text-ink-3 hover:text-ink-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting}
              className="bg-primary text-primary-foreground shadow-none hover:bg-primary-strong"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Send request
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  optional,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium text-ink-2">
        {label}
        {optional ? <span className="ml-1 font-normal text-ink-4">(optional)</span> : null}
      </Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function Stepper({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border text-ink-2 transition-colors hover:bg-muted disabled:opacity-40"
    >
      {children}
    </button>
  );
}
