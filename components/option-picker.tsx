"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
  type Transition,
  type Variants,
} from "motion/react";
import { CheckIcon } from "./icons";
import { OptionIcon, type Option } from "./options";
import styles from "./option-picker.module.css";

type PickerProps = {
  id: string;
  open: boolean;
  title: string;
  options: Option[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
};

const panelSpring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.35 };
const itemSpring: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.4 };
const wobble: Transition = { type: "spring", visualDuration: 0.4, bounce: 0.6 };

const listVariants: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.035, delayChildren: 0.04 } },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.94 },
  shown: { opacity: 1, y: 0, scale: 1, transition: itemSpring },
};

const iconVariants: Variants = {
  rest: { scale: 1, rotate: 0 },
  active: { scale: 1.12, rotate: -10 },
};

const subscribe = () => () => {};

/**
 * A centered, dropdown-style option picker. There is deliberately no
 * backdrop: the overlay is transparent and only catches outside clicks.
 */
export function OptionPicker(props: PickerProps) {
  const isClient = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  if (!isClient) return null;

  return createPortal(
    <AnimatePresence>{props.open && <Panel key="panel" {...props} />}</AnimatePresence>,
    document.body,
  );
}

function Panel({ id, title, options, selectedIndex, onSelect, onClose }: PickerProps) {
  const [active, setActive] = useState(Math.max(selectedIndex, 0));
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const isPresent = useIsPresent();
  const reduceMotion = useReducedMotion();
  const titleId = useId();

  useEffect(() => {
    if (isPresent) optionRefs.current[active]?.focus({ preventScroll: true });
  }, [active, isPresent]);

  const onKeyDown = (event: KeyboardEvent) => {
    const last = options.length - 1;
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => (i === last ? 0 : i + 1)),
      ArrowUp: () => setActive((i) => (i === 0 ? last : i - 1)),
      Home: () => setActive(0),
      End: () => setActive(last),
      Escape: onClose,
      // Focus stays inside the modal; there is only one tab stop.
      Tab: () => {},
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  return (
    <div
      className={styles.overlay}
      style={isPresent ? undefined : { pointerEvents: "none" }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={styles.panel}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 12 }}
        transition={panelSpring}
        onKeyDown={onKeyDown}
      >
        <p id={titleId} className={styles.title}>
          {title}
        </p>
        <motion.div
          role="listbox"
          aria-labelledby={titleId}
          className={styles.list}
          variants={listVariants}
          initial="hidden"
          animate="shown"
        >
          {options.map((option, i) => (
            <motion.button
              key={option.label}
              ref={(node) => {
                optionRefs.current[i] = node;
              }}
              type="button"
              role="option"
              aria-selected={i === selectedIndex}
              tabIndex={i === active ? 0 : -1}
              className={styles.option}
              variants={itemVariants}
              whileTap={{ scale: 0.96 }}
              // Only a real pointer move picks an option. The panel springs in
              // under a resting pointer, and the rows sliding past it fire
              // pointerenter, which would steal the highlight and focus from
              // the selected option.
              onPointerMove={(event) => {
                if (event.movementX || event.movementY) setActive(i);
              }}
              onClick={() => onSelect(i)}
            >
              {i === active && (
                <motion.span
                  layoutId={`${id}-highlight`}
                  className={styles.highlight}
                  transition={panelSpring}
                />
              )}
              <motion.span
                className={styles.icon}
                variants={iconVariants}
                initial={false}
                animate={i === active ? "active" : "rest"}
                transition={wobble}
              >
                <OptionIcon option={option} />
              </motion.span>
              <span className={styles.label}>{option.label}</span>
              {i === selectedIndex && (
                <motion.span
                  className={styles.check}
                  initial={{ scale: 0, rotate: -45 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ ...wobble, delay: 0.12 }}
                >
                  <CheckIcon />
                </motion.span>
              )}
            </motion.button>
          ))}
        </motion.div>
      </motion.div>
    </div>
  );
}
