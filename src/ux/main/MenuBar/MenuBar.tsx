import React, { useState, useRef, useEffect, useCallback } from "react";
import type { MenuNode } from "../menu/menuTree";
import styles from "./MenuBar.module.scss";

interface MenuBarProps {
  menus?: MenuNode[];
}

/** Translate Electron-style accelerator (`"CmdOrCtrl+T"`) to the
 *  Windows/Linux idiomatic form (`"Ctrl+T"`). Identity on the macOS
 *  side; the in-app menu only renders on Windows/Linux, but accept
 *  legacy `Cmd` literals for safety. */
function formatShortcut(shortcut: string): string {
  return shortcut.replace(/CmdOrCtrl/g, "Ctrl").replace(/\bCmd\b/g, "Ctrl");
}

// ─── SubmenuItem ──────────────────────────────────────────────────────────────

interface SubmenuItemProps {
  item: MenuNode;
  onClose: () => void;
}

function SubmenuItem({ item, onClose }: SubmenuItemProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  if (item.submenu) {
    return (
      <li
        role="none"
        className={styles.submenuEntry}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <button
          className={`${styles.menuItem} ${styles.hasSubmenu}`}
          disabled={item.disabled}
          role="menuitem"
          aria-haspopup="true"
          aria-expanded={open}
        >
          <span className={styles.checkMark} />
          <span className={styles.itemLabel}>{item.label}</span>
          <span className={styles.submenuArrow}>›</span>
        </button>
        {open && (
          <ul
            className={`${styles.dropdown} ${styles.submenuDropdown}`}
            role="menu"
          >
            {item.submenu.map((sub, i) =>
              sub.separator ? (
                <li key={i} role="separator" className={styles.separator} />
              ) : (
                <SubmenuItem key={sub.label + i} item={sub} onClose={onClose} />
              ),
            )}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li role="none">
      <button
        className={styles.menuItem}
        onClick={() => {
          if (!item.disabled && !item.separator) {
            item.action?.();
            onClose();
          }
        }}
        role="menuitem"
        disabled={item.disabled}
      >
        <span className={styles.checkMark}>{item.checked ? "✓" : ""}</span>
        <span className={styles.itemLabel}>{item.label}</span>
        {item.shortcut && (
          <span className={styles.shortcut}>{formatShortcut(item.shortcut)}</span>
        )}
      </button>
    </li>
  );
}

// ─── MenuBar ──────────────────────────────────────────────────────────────────

export function MenuBar({ menus }: MenuBarProps): React.JSX.Element {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);

  const close = useCallback(() => setOpenMenu(null), []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent): void => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        close();
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close]);

  const handleTrigger = (label: string): void => {
    setOpenMenu((prev) => (prev === label ? null : label));
  };

  const handleMouseEnter = (label: string): void => {
    if (openMenu !== null && openMenu !== label) {
      setOpenMenu(label);
    }
  };

  if (menus === undefined)
    return (
      <nav
        ref={navRef}
        className={styles.menuBar}
        aria-label="Application menu"
      />
    );

  return (
    <nav ref={navRef} className={styles.menuBar} aria-label="Application menu">
      {menus.map((menu) => (
        <div key={menu.label} className={styles.entry}>
          <button
            className={`${styles.trigger} ${openMenu === menu.label ? styles.open : ""}`}
            onClick={() => {
              if (menu.disabled) return;
              handleTrigger(menu.label);
            }}
            onMouseEnter={() => {
              if (menu.disabled) return;
              handleMouseEnter(menu.label);
            }}
            disabled={menu.disabled}
            aria-haspopup="menu"
            aria-expanded={openMenu === menu.label}
          >
            {menu.label}
          </button>

          {openMenu === menu.label && !menu.disabled && menu.submenu && (
            <ul className={styles.dropdown} role="menu">
              {menu.submenu.map((item, i) =>
                item.separator ? (
                  <li key={i} role="separator" className={styles.separator} />
                ) : (
                  <SubmenuItem
                    key={item.label + i}
                    item={item}
                    onClose={close}
                  />
                ),
              )}
            </ul>
          )}
        </div>
      ))}
    </nav>
  );
}
