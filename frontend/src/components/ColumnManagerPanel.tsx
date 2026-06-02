import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLanguage } from "../hooks/useLanguage";

interface ColumnManagerPanelProps<Id extends string> {
  triggerRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  order: Id[];
  hidden: Set<Id>;
  /** Look up the display label for one column id. */
  labelFor: (id: Id) => string;
  onToggleVisibility: (id: Id) => void;
  onReorder: (fromId: Id, toId: Id) => void;
  onReset: () => void;
}

interface RowProps {
  id: string;
  label: string;
  visible: boolean;
  onToggle: () => void;
}

function SortableRow({ id, label, visible, onToggle }: RowProps) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 px-2 py-1.5 rounded-md surface-1 surface-1-hover"
    >
      <input
        type="checkbox"
        checked={visible}
        onChange={onToggle}
        aria-label={label}
        className="cursor-pointer"
      />
      <span className="text-sm flex-1 select-none">{label}</span>
      <button
        type="button"
        aria-label="Reorder"
        title="Drag to reorder"
        className="opacity-50 hover:opacity-100 cursor-grab active:cursor-grabbing px-1"
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
    </li>
  );
}

export function ColumnManagerPanel<Id extends string>({
  triggerRef, open, onClose,
  order, hidden, labelFor, onToggleVisibility, onReorder, onReset,
}: ColumnManagerPanelProps<Id>) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const { t } = useLanguage();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (
        !triggerRef.current?.contains(tgt) &&
        !panelRef.current?.contains(tgt)
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, triggerRef]);

  if (!open || !pos) return null;

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    onReorder(active.id as Id, over.id as Id);
  }

  // Preserve order; arrayMove just lets us preview during drag.
  const previewOrder = order;
  void arrayMove; // keeps import live for future preview tweaks

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("details.columnsManagerTitle")}
      style={{
        position: "fixed", top: pos.top, right: pos.right,
        zIndex: 1500, width: 280,
      }}
      className="solid-panel p-3"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs uppercase tracking-wide opacity-60">
          {t("details.columnsManagerTitle")}
        </div>
        <button
          type="button"
          onClick={onReset}
          className="text-xs opacity-70 hover:opacity-100 underline"
        >
          {t("details.columnsManagerReset")}
        </button>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={previewOrder} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-1 max-h-[60vh] overflow-y-auto">
            {previewOrder.map((id) => (
              <SortableRow
                key={id}
                id={id}
                label={labelFor(id)}
                visible={!hidden.has(id)}
                onToggle={() => onToggleVisibility(id)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      <p className="text-[11px] opacity-50 mt-2">
        {t("details.columnsManagerHint")}
      </p>
    </div>,
    document.body,
  );
}
