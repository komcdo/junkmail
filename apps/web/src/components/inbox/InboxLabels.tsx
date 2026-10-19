import { PlusIcon, XIcon } from "lucide-react";
import { useId, useState, type CSSProperties } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

// Hashing keeps a label's color stable everywhere without storing one per label.
const LABEL_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#6366f1",
  "#84cc16",
];

export function inboxLabelColor(label: string): string {
  let hash = 0;
  for (const char of label.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return LABEL_COLORS[Math.abs(hash) % LABEL_COLORS.length] ?? LABEL_COLORS[0]!;
}

export function InboxLabelChip(props: {
  readonly label: string;
  readonly active?: boolean;
  readonly onClick?: () => void;
  readonly onRemove?: () => void;
}) {
  const style = { "--label": inboxLabelColor(props.label) } as CSSProperties;
  return (
    <Badge
      size="sm"
      variant="label"
      style={style}
      data-active={props.active || undefined}
      className="max-w-36 shrink-0"
      render={
        props.onClick ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onClick?.();
            }}
          />
        ) : undefined
      }
    >
      <span className="truncate">{props.label}</span>
      {props.onRemove ? (
        <span
          role="button"
          tabIndex={0}
          aria-label={`Remove label ${props.label}`}
          className="-mr-0.5 inline-flex cursor-pointer opacity-60 hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            props.onRemove?.();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              props.onRemove?.();
            }
          }}
        >
          <XIcon className="size-3" />
        </span>
      ) : null}
    </Badge>
  );
}

export function InboxLabelEditor(props: {
  readonly labels: ReadonlyArray<string>;
  readonly suggestions: ReadonlyArray<string>;
  readonly onChange: (labels: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const listId = useId();
  const commit = () => {
    const label = draft.trim();
    setDraft("");
    setAdding(false);
    if (label.length === 0) return;
    if (props.labels.some((existing) => existing.toLowerCase() === label.toLowerCase())) return;
    props.onChange([...props.labels, label]);
  };
  const remaining = props.suggestions.filter(
    (suggestion) => !props.labels.some((label) => label.toLowerCase() === suggestion.toLowerCase()),
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {props.labels.map((label) => (
        <InboxLabelChip
          key={label}
          label={label}
          onRemove={() => props.onChange(props.labels.filter((existing) => existing !== label))}
        />
      ))}
      {adding ? (
        <form
          className="w-32"
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
        >
          <Input
            size="compact"
            autoFocus
            value={draft}
            list={listId}
            maxLength={40}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
            placeholder="Label"
            aria-label="New label"
          />
          <datalist id={listId}>
            {remaining.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </form>
      ) : (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Add label"
          onClick={() => setAdding(true)}
        >
          <PlusIcon />
        </Button>
      )}
    </div>
  );
}
