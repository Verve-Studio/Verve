import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./SliderInput.module.scss";

interface SliderInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Width of the text box in px */
  inputWidth?: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
  className?: string;
}

export function SliderInput({
  value,
  min,
  max,
  step = 1,
  inputWidth = 42,
  suffix,
  disabled = false,
  onChange,
  className,
}: SliderInputProps): React.JSX.Element {
  const [text, setText] = useState(String(value));
  const [open, setOpen] = useState(false);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number }>({
    top: -9999,
    left: -9999,
  });
  const rootRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLSpanElement>(null);
  // Set to true when mousedown starts on the popup so onBlur doesn't close it
  const suppressBlurRef = useRef(false);

  // Keep text in sync when value changes externally
  useEffect(() => {
    setText(String(value));
  }, [value]);

  // Close popup if user clicks outside both the input and the portal popup
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const inRoot = rootRef.current?.contains(e.target as Node) ?? false;
      const inPopup = popupRef.current?.contains(e.target as Node) ?? false;
      if (!inRoot && !inPopup) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Measure popup and clamp to viewport — runs before browser paints
  useLayoutEffect(() => {
    if (!open || !inputRef.current || !popupRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    const pw = popupRef.current.offsetWidth;
    const ph = popupRef.current.offsetHeight;
    const margin = 4;

    let top = rect.bottom + margin;
    let left = rect.left;

    // Clamp right edge
    if (left + pw > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - pw - margin);
    }
    // Flip above if overflows bottom
    if (top + ph > window.innerHeight - margin) {
      top = rect.top - margin - ph;
    }
    // Clamp top edge
    if (top < margin) top = margin;

    setPopupPos({ top, left });
  }, [open]);

  const clamp = (v: number): number => Math.min(max, Math.max(min, v));

  const commitText = (raw: string): void => {
    const n = parseFloat(raw);
    if (!isNaN(n)) {
      const clamped = clamp(step < 1 ? n : Math.round(n / step) * step);
      onChange(clamped);
      setText(String(clamped));
    } else {
      setText(String(value));
    }
  };

  const handleFocus = (): void => {
    if (!disabled) setOpen(true);
  };

  const handleTextKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      commitText((e.target as HTMLInputElement).value);
      setOpen(false);
    } else if (e.key === "Escape") {
      setText(String(value));
      setOpen(false);
    }
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const n = parseFloat(e.target.value);
    onChange(n);
    setText(String(n));
  };

  return (
    <span
      ref={rootRef}
      className={`${styles.root}${className ? ` ${className}` : ""}`}
    >
      <span className={styles.inputWrap}>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          className={styles.input}
          style={{ width: inputWidth }}
          value={text}
          disabled={disabled}
          onFocus={handleFocus}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => {
            if (suppressBlurRef.current) {
              suppressBlurRef.current = false;
              return;
            }
            commitText(e.target.value);
            setOpen(false);
          }}
          onKeyDown={handleTextKey}
          aria-label={`value ${min}–${max}`}
        />
        {suffix && <span className={styles.suffix}>{suffix}</span>}
      </span>

      {open &&
        !disabled &&
        createPortal(
          <span
            ref={popupRef}
            className={styles.popup}
            style={{ top: popupPos.top, left: popupPos.left }}
            onMouseDown={() => {
              suppressBlurRef.current = true;
            }}
          >
            <input
              type="range"
              className={styles.slider}
              min={min}
              max={max}
              step={step}
              value={value}
              onChange={handleSliderChange}
            />
          </span>,
          document.body,
        )}
    </span>
  );
}
