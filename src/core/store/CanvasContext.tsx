import React, { createContext, useContext, useRef } from "react";

// Shared mutable ref to the WebGL canvas element so any panel (e.g. Navigator)
// can read its rendered content without prop-drilling.
// thumbnailCanvasRef is a separate 2D canvas that Canvas.tsx blits to after each
// render — the Navigator reads from this instead of the WebGPU canvas directly.

interface CanvasContextValue {
  canvasElRef: React.RefObject<HTMLCanvasElement | null>;
  thumbnailCanvasRef: React.RefObject<HTMLCanvasElement | null>;
}

const CanvasContext = createContext<CanvasContextValue | null>(null);

export function CanvasProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const thumbnailCanvasRef = useRef<HTMLCanvasElement | null>(null);
  return (
    <CanvasContext.Provider value={{ canvasElRef, thumbnailCanvasRef }}>
      {children}
    </CanvasContext.Provider>
  );
}

export function useCanvasContext(): CanvasContextValue {
  const ctx = useContext(CanvasContext);
  if (!ctx)
    throw new Error("useCanvasContext must be used within a CanvasProvider");
  return ctx;
}
