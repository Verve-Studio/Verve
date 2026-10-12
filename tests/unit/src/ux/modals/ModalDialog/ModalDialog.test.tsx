import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ModalDialog } from "@/ux/modals/ModalDialog/ModalDialog";

afterEach(cleanup);

/** A dialog whose field only commits its text on Enter / blur, like SliderInput. */
function Harness({ onSubmit, onOuterKey }: { onSubmit: (v: string) => void; onOuterKey?: () => void }) {
  const [value, setValue] = useState("old");
  const [text, setText] = useState("old");
  return (
    <div onKeyDown={onOuterKey}>
      <ModalDialog open title="Test" onClose={() => {}} onSubmit={() => onSubmit(value)}>
        <input
          aria-label="field"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setValue(text);
          }}
        />
        <textarea aria-label="notes" />
        <button type="button">Cancel</button>
      </ModalDialog>
    </div>
  );
}

describe("ModalDialog onSubmit", () => {
  it("Enter in a field submits after the field has committed its value", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const field = screen.getByLabelText("field");
    fireEvent.change(field, { target: { value: "new" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("new");
  });

  it("Enter with focus outside the dialog submits and doesn't reach other listeners", () => {
    const onSubmit = vi.fn();
    const docListener = vi.fn();
    document.addEventListener("keydown", docListener);
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.keyDown(document.body, { key: "Enter" });
    document.removeEventListener("keydown", docListener);
    expect(onSubmit).toHaveBeenCalledWith("old");
    expect(docListener).not.toHaveBeenCalled();
  });

  it("Enter inside the dialog doesn't bubble to the app", () => {
    const onOuterKey = vi.fn();
    const docListener = vi.fn();
    document.addEventListener("keydown", docListener);
    render(<Harness onSubmit={vi.fn()} onOuterKey={onOuterKey} />);
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "Enter" });
    document.removeEventListener("keydown", docListener);
    expect(onOuterKey).not.toHaveBeenCalled();
    expect(docListener).not.toHaveBeenCalled();
  });

  it("Enter on a button or in a textarea keeps its own meaning", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByLabelText("notes"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a field can opt out with preventDefault", () => {
    const onSubmit = vi.fn();
    render(
      <ModalDialog open title="T" onClose={() => {}} onSubmit={onSubmit}>
        <input aria-label="f" onKeyDown={(e) => e.preventDefault()} />
      </ModalDialog>,
    );
    fireEvent.keyDown(screen.getByLabelText("f"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("without onSubmit, Enter is left alone", () => {
    const docListener = vi.fn();
    document.addEventListener("keydown", docListener);
    render(
      <ModalDialog open title="T" onClose={() => {}}>
        <input aria-label="f" />
      </ModalDialog>,
    );
    fireEvent.keyDown(screen.getByLabelText("f"), { key: "Enter" });
    document.removeEventListener("keydown", docListener);
    expect(docListener).toHaveBeenCalledTimes(1);
  });
});
