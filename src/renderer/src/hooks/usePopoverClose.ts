/**
 * usePopoverClose Hook
 *
 * Provides popover close logic for click outside + Escape key.
 * A reusable hook for managing popover/dropdown close behavior.
 *
 * @module hooks/usePopoverClose
 */

import { useEffect } from 'react';

/**
 * Hook for popover close logic (click outside + Esc)
 *
 * @param open - Current open state of the popover
 * @param setOpen - State setter to control popover open state
 * @param btnRef - Reference to the trigger button element
 * @param panelRef - Reference to the popover panel element
 *
 * @example
 * ```tsx
 * const [open, setOpen] = useState(false);
 * const btnRef = useRef<HTMLButtonElement>(null);
 * const panelRef = useRef<HTMLDivElement>(null);
 *
 * usePopoverClose(open, setOpen, btnRef, panelRef);
 * ```
 */
export function usePopoverClose(
  open: boolean,
  setOpen: (v: boolean) => void,
  btnRef: React.RefObject<HTMLElement | null>,
  panelRef: React.RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!open) return;

    const handleOutside = (e: MouseEvent) => {
      if (
        btnRef.current?.contains(e.target as Node) ||
        panelRef.current?.contains(e.target as Node)
      )
        return;
      setOpen(false);
    };

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);

    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [open, setOpen, btnRef, panelRef]);
}
