import type { CSSProperties } from "react";
export type IconName =
  | "receipt"
  | "box"
  | "grid"
  | "list"
  | "search"
  | "plus"
  | "close"
  | "arrow"
  | "logout"
  | "eye"
  | "eyeOff"
  | "lock"
  | "calendar"
  | "headphones"
  | "shirt"
  | "camera"
  | "chair"
  | "basket"
  | "more"
  | "chevron"
  | "check";
const paths: Record<IconName, React.ReactNode> = {
  receipt: <path d="M5 3h14v20l-3-2-4 2-4-2-3 2V3ZM8 8h8M8 12h8M8 16h4" />,
  box: (
    <>
      <path d="m12 2 8 4-8 4-8-4 8-4Z M4 6v9l8 4 8-4V6 M12 10v9" />
      <path d="m4 11-2 1v7l10 5 10-5v-7l-2-1 M2 12l10 5 10-5" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  list: (
    <>
      <path d="M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="7" />
      <path d="m16 16 5 5" />
    </>
  ),
  plus: <path d="M12 4v16M4 12h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  logout: (
    <>
      <path d="M10 3H4v18h6M10 12h11m-5-5 5 5-5 5" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="m3 3 18 18M10 5c7-1 12 7 12 7a24 24 0 0 1-4 4M6 6a23 23 0 0 0-4 6s4 7 10 7c2 0 4-.8 5-1.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M7 3v4M17 3v4M3 10h18" />
    </>
  ),
  headphones: (
    <>
      <path d="M4 15v-4a8 8 0 0 1 16 0v4M6 13v-2a6 6 0 0 1 12 0v2" />
      <rect
        x="3"
        y="12"
        width="5"
        height="9"
        rx="2"
        transform="rotate(-12 5 16)"
      />
      <rect
        x="16"
        y="12"
        width="5"
        height="9"
        rx="2"
        transform="rotate(12 18 16)"
      />
    </>
  ),
  shirt: (
    <>
      <path d="m8 3-6 4 3 5 3-2v11h8V10l3 2 3-5-6-4-4 2-4-2Z M8 3l4 6 4-6M12 9v12M14 11h2" />
    </>
  ),
  camera: (
    <>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="m7 7 2-4h6l2 4M4 5h2v2M18 10h2" />
      <circle cx="12" cy="14" r="5" />
      <circle cx="12" cy="14" r="3.4" />
    </>
  ),
  chair: (
    <>
      <path d="M6 11V7a6 6 0 0 1 12 0v4M6 16h12M6 12a2 2 0 0 0-4 0v5a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3v-5a2 2 0 0 0-4 0v4M6 12v4M5 20l-1 3M19 20l1 3" />
    </>
  ),
  basket: (
    <>
      <path d="M2 9h20l-3 12H5L2 9ZM7 9l4-7M17 9l-4-7M8 13v4M12 13v4M16 13v4" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  check: <path d="m4 12 5 5L20 6" />,
};
export function Icon({
  name,
  size = 20,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 26"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function Brand() {
  return (
    <div className="brand">
      <Icon name="box" size={35} />
      <span>Inventory</span>
    </div>
  );
}
export function categoryIcon(name: string): IconName {
  return (
    (
      {
        Tech: "headphones",
        Clothes: "shirt",
        Hobbies: "camera",
        Furniture: "chair",
        Groceries: "basket",
      } as Record<string, IconName>
    )[name] ?? "box"
  );
}
