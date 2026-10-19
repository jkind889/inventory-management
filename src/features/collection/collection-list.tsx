import { TagChips } from "@/features/tags/tag-controls";
import {
  formatDate,
  formatMoney,
  type Category,
  type CollectionItem,
} from "@/shared/collection";

export function CollectionList({
  items,
  categories,
  currency,
  openItem,
  selected, checked, toggleChecked,
}: {
  items: CollectionItem[];
  categories: Category[];
  currency: string;
  openItem: (id: string) => void;
  selected?: string | null; checked?: string[]; toggleChecked?: (id: string) => void;
}) {
  return (
    <ul className="collection-register" aria-label="Collection items">
      {items.map((item) => {
        const category =
          categories.find((c) => c.id === item.categoryId)?.name ?? "Other";
        const price =
          item.recordedCostMinor === null
            ? "Price not recorded"
            : formatMoney(item.recordedCostMinor, currency);
        const date = formatDate(item.acquiredOn);
        return (
          <li key={item.id} className={toggleChecked ? "register-selectable" : undefined}>
            {toggleChecked && <input className="register-checkbox" type="checkbox" aria-label={`Select ${item.name}`} checked={checked?.includes(item.id) ?? false} onChange={() => toggleChecked(item.id)} />}
            <button
              className="collection-register-row"
              onClick={() => openItem(item.id)}
              aria-pressed={selected === item.id}
              aria-label={`${item.name}, ${category}, ${price}, ${date}`}
            >
              <span className="register-item"><h2 className="register-name">{item.name}{item.state && item.state !== "owned" && <small> · {item.state}</small>}</h2><TagChips tags={item.tags} compact /></span>
              <span className="register-category">{category}</span>
              <span className="register-price" aria-label={price}>
                {item.recordedCostMinor === null ? "—" : price}
              </span>
              <span className="register-date" aria-label={date}>
                {item.acquiredOn ? (
                  <time dateTime={item.acquiredOn}>{date}</time>
                ) : (
                  "—"
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
