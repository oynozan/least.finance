"use client";

import {
  useCallback,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useReducedMotion,
  type Transition,
  type Variants,
} from "motion/react";
import { ChevronIcon } from "./icons";
import { OptionPicker } from "./option-picker";
import {
  CUSTOMIZABLES,
  OptionIcon,
  TOOLS,
  VISUALS,
  type Option,
} from "./options";
import styles from "./hero-heading.module.css";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.45 };
const wobble: Transition = { type: "spring", visualDuration: 0.4, bounce: 0.6 };
const resize: Transition = { type: "spring", visualDuration: 0.4, bounce: 0.25 };

const pillVariants: Variants = {
  hover: { scale: 1.05 },
  tap: { scale: 0.92 },
};

const iconVariants: Variants = {
  rest: { scale: 1, rotate: 0 },
  hover: { scale: 1.12, rotate: -10 },
  tap: { scale: 0.88, rotate: 4 },
};

export function HeroHeading() {
  return (
    <MotionConfig reducedMotion="user">
      <h1 className={styles.heading}>
        A tool to create visual{" "}
        <span className={styles.nowrap}>
          <CyclingPill options={VISUALS} />,
        </span>{" "}
        customize{" "}
        <span className={styles.nowrap}>
          <CyclingPill options={CUSTOMIZABLES} />,
        </span>{" "}
        and build interfaces with{" "}
        <span className={styles.nowrap}>
          <PickerPill options={TOOLS} title="Build interfaces with" />.
        </span>
      </h1>
    </MotionConfig>
  );
}

function CyclingPill({ options }: { options: Option[] }) {
  const [index, setIndex] = useState(0);

  return (
    <Pill
      option={options[index]}
      onClick={() => setIndex((i) => (i + 1) % options.length)}
    />
  );
}

/** Opens the option picker; the label only changes once an option is chosen. */
function PickerPill({ options, title }: { options: Option[]; title: string }) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pickerId = useId();

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <Pill
        ref={buttonRef}
        option={options[index]}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? pickerId : undefined}
        trailing={
          <motion.span
            className={styles.chevron}
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
            transition={spring}
          >
            <ChevronIcon />
          </motion.span>
        }
      />
      <OptionPicker
        id={pickerId}
        open={open}
        title={title}
        options={options}
        selectedIndex={index}
        onSelect={(i) => {
          setIndex(i);
          close();
        }}
        onClose={close}
      />
    </>
  );
}

type PillProps = {
  option: Option;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
  trailing?: ReactNode;
} & Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-haspopup" | "aria-expanded" | "aria-controls"
>;

function Pill({ option, onClick, ref, trailing, ...aria }: PillProps) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const reduceMotion = useReducedMotion();

  const { label } = option;

  // Only an option change springs the width; resizes and font swaps snap,
  // otherwise the clipped track would cut off glyphs while it catches up.
  const [shownLabel, setShownLabel] = useState(label);
  const [swapping, setSwapping] = useState(false);
  if (shownLabel !== label) {
    setShownLabel(label);
    setSwapping(true);
  }

  // Each option's content reports its own width, so the track can spring
  // between them and the surrounding words reflow smoothly.
  const measure = useCallback((node: HTMLSpanElement | null) => {
    if (!node) return;
    const key = node.dataset.option ?? "";
    const observer = new ResizeObserver(() =>
      setWidths((current) =>
        current[key] === node.offsetWidth
          ? current
          : { ...current, [key]: node.offsetWidth },
      ),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // The icon pose is driven by state rather than inherited from the button's
  // whileHover/whileTap: an icon mounted by a swap must join a gesture that
  // is already active, which variant inheritance can't do.
  const iconPose = pressed ? "tap" : hovered ? "hover" : "rest";

  return (
    <motion.button
      ref={ref}
      type="button"
      className={styles.pill}
      aria-label={label}
      {...aria}
      onClick={onClick}
      variants={pillVariants}
      initial={false}
      whileHover="hover"
      whileTap="tap"
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      onTapStart={() => setPressed(true)}
      onTap={() => setPressed(false)}
      onTapCancel={() => setPressed(false)}
      transition={spring}
    >
      <motion.span
        className={styles.track}
        initial={false}
        animate={{ width: widths[label] ?? "auto" }}
        transition={swapping && !reduceMotion ? resize : { duration: 0 }}
        onAnimationComplete={() => setSwapping(false)}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={label}
            className={styles.swap}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, y: "40%" }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, y: "-40%" }}
            transition={spring}
          >
            <span ref={measure} data-option={label} className={styles.content}>
              <motion.span
                className={styles.icon}
                variants={iconVariants}
                initial="rest"
                animate={iconPose}
                transition={wobble}
              >
                <OptionIcon option={option} />
              </motion.span>
              <span className={styles.label}>{label}</span>
            </span>
          </motion.span>
        </AnimatePresence>
      </motion.span>
      {trailing}
    </motion.button>
  );
}
