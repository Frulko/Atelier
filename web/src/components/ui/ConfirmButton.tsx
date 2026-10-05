import { useEffect, useState, type ComponentProps } from "react";
import { Button } from "./Button";

/** Action destructrice en deux clics (pas de boîte du navigateur) : le premier arme le bouton, le second confirme. */
export function ConfirmButton({ onConfirm, children, confirmLabel = "Confirmer ?", ...rest }: Omit<ComponentProps<typeof Button>, "onClick"> & { onConfirm: () => void; confirmLabel?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3500); return () => clearTimeout(t); }, [armed]);
  return (
    <Button {...rest} variant={armed ? "danger" : rest.variant} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? confirmLabel : children}
    </Button>
  );
}
