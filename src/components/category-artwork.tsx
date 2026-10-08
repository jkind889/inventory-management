import { Icon, categoryIcon } from "./icon";
export function CategoryArtwork({
  category,
  small = false,
}: {
  category: string;
  small?: boolean;
}) {
  return (
    <div
      className={`artwork tone-${category.toLowerCase()} ${small ? "small-art" : ""}`}
    >
      <Icon name={categoryIcon(category)} size={small ? 34 : 72} />
      {!small && <span className="artwork-label">Category artwork</span>}
    </div>
  );
}
