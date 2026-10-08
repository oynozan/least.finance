import type { ComponentType, SVGProps } from "react";
import {
  AgentsIcon,
  ChatBubblesIcon,
  CodeIcon,
  ColorIcon,
  CursorIcon,
  IdentitiesIcon,
  PencilIcon,
  SparkleIcon,
  StarIcon,
  SystemsIcon,
  TypeIcon,
} from "./icons";

export type Option = {
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Icon width and height in em, so it scales with the surrounding text. */
  size: readonly [number, number];
};

const SQUARE = [1.3, 1.3] as const;

// Mock content.
export const VISUALS: Option[] = [
  { label: "languages", Icon: ChatBubblesIcon, size: [1.32, 1.4] },
  { label: "systems", Icon: SystemsIcon, size: SQUARE },
  { label: "identities", Icon: IdentitiesIcon, size: SQUARE },
];

export const CUSTOMIZABLES: Option[] = [
  { label: "type", Icon: TypeIcon, size: [1.3, 0.88] },
  { label: "color", Icon: ColorIcon, size: SQUARE },
  { label: "icons", Icon: StarIcon, size: SQUARE },
];

export const TOOLS: Option[] = [
  { label: "Cursor", Icon: CursorIcon, size: SQUARE },
  { label: "Code", Icon: CodeIcon, size: SQUARE },
  { label: "Agents", Icon: AgentsIcon, size: SQUARE },
  { label: "Prompts", Icon: SparkleIcon, size: SQUARE },
  { label: "Sketches", Icon: PencilIcon, size: SQUARE },
];

export function OptionIcon({ option }: { option: Option }) {
  const {
    Icon,
    size: [width, height],
  } = option;
  return <Icon style={{ width: `${width}em`, height: `${height}em` }} />;
}
