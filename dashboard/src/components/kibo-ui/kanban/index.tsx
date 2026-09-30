"use client";

/*
 * Switchboard: vendored from Kibo UI's Kanban (registry item `kanban`,
 * https://www.kibo-ui.com/r/kanban.json, MIT, (c) 2023 - present shadcnblocks;
 * by Hayden Bleasel). See THIRD_PARTY_NOTICES.md.
 *
 * Kept: the KanbanProvider / KanbanBoard / KanbanHeader / KanbanCards /
 * KanbanCard structure, dnd-kit's DndContext with mouse, touch and keyboard
 * sensors, the tunnel-rat DragOverlay, and the screen-reader announcements.
 *
 * Changed:
 * - The board never moves a card on its own. Kibo reassigns `item.column`
 *   during dragOver and hands the new array to onDataChange; here a move is a
 *   request to the Channel, which may refuse it, so the provider only reports
 *   `onMove(item, from, to)` on drop and the caller decides. Nothing is
 *   mutated, so a refused drop snaps back by itself.
 * - Pointer sensors need 5px of travel (touch: a 200ms press) before a drag
 *   starts, so a card can still be clicked; `pointerDrag={false}` leaves only
 *   the keyboard, for phones where a "Move to" menu replaces dragging.
 * - Keyboard: Space picks up and drops, Escape cancels, arrows move between
 *   columns (sortableKeyboardCoordinates). Enter and a click open the card.
 * - Re-skinned through the ShlokOS token layer: Card and ScrollArea become
 *   bevelled Motif panes, no rounded corners, no shadows, no ring.
 */

import type {
  Announcements,
  CollisionDetection,
  DndContextProps,
  DragEndEvent,
  DragStartEvent,
  KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import {
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createContext, type HTMLAttributes, type ReactNode, useContext, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import tunnel from "tunnel-rat";
import { cn } from "@/lib/utils";

const t = tunnel();

export type { DragEndEvent } from "@dnd-kit/core";

export type KanbanItemProps = {
  id: string;
  name: string;
  column: string;
} & Record<string, unknown>;

export type KanbanColumnProps = {
  id: string;
  name: string;
} & Record<string, unknown>;

type KanbanContextProps<
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
> = {
  columns: C[];
  data: T[];
  activeCardId: string | null;
  overColumn: string | null;
  /** When the last drag ended, so the click that ends a drag does not also open the card. */
  droppedAt: { current: number };
};

const KanbanContext = createContext<KanbanContextProps>({
  columns: [],
  data: [],
  activeCardId: null,
  overColumn: null,
  droppedAt: { current: 0 },
});

/** The column the pointer (or keyboard focus) is over, while a card is held. */
export const useKanbanOver = () => useContext(KanbanContext).overColumn;

export type KanbanBoardProps = {
  id: string;
  children: ReactNode;
  className?: string;
};

export const KanbanBoard = ({ id, children, className }: KanbanBoardProps) => {
  const { setNodeRef } = useDroppable({ id, data: { column: id } });
  const { overColumn, activeCardId } = useContext(KanbanContext);
  const isOver = activeCardId !== null && overColumn === id;

  return (
    <div
      className={cn(
        "bevel-out relative flex size-full min-h-40 flex-col bg-secondary text-xs",
        isOver && "outline-2 outline-offset-[-2px] outline-[hsl(var(--primary))] outline-dashed",
        className,
      )}
      data-over={isOver || undefined}
      data-kanban-column={id}
      ref={setNodeRef}
    >
      {children}
    </div>
  );
};

export type KanbanCardProps<T extends KanbanItemProps = KanbanItemProps> = T & {
  children?: ReactNode;
  className?: string;
  /** Click or Enter on a card that is not being dragged. */
  onOpen?: () => void;
};

export const KanbanCard = <T extends KanbanItemProps = KanbanItemProps>({
  id,
  name,
  column,
  children,
  className,
  onOpen,
}: KanbanCardProps<T>) => {
  const { attributes, listeners, setNodeRef, transition, transform, isDragging } = useSortable({
    id,
    data: { column },
  });
  const { activeCardId, droppedAt } = useContext(KanbanContext) as KanbanContextProps;
  const idle = () => activeCardId === null && Date.now() - droppedAt.current > 250;

  const style = {
    transition,
    transform: CSS.Translate.toString(transform),
  };

  return (
    <>
      <div
        style={style}
        {...listeners}
        {...attributes}
        onKeyDown={(e) => {
          listeners?.onKeyDown?.(e);
          if (e.key === "Enter" && e.target === e.currentTarget && idle()) onOpen?.();
        }}
        onClick={(e) => {
          // A click on a control inside the card (a menu, a link) belongs to that control.
          if ((e.target as HTMLElement).closest("a,button,[role=menuitem]")) return;
          if (idle()) onOpen?.();
        }}
        aria-roledescription="Task card"
        ref={setNodeRef}
        className="outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[hsl(var(--ring))]"
      >
        <div
          className={cn(
            "bevel-thin cursor-grab bg-card p-2 text-card-foreground",
            isDragging && "pointer-events-none cursor-grabbing opacity-40",
            className,
          )}
        >
          {children ?? <p className="m-0 text-sm font-medium">{name}</p>}
        </div>
      </div>
      {activeCardId === id && (
        <t.In>
          <div className={cn("bevel-out cursor-grabbing bg-card p-2 text-card-foreground", className)}>
            {children ?? <p className="m-0 text-sm font-medium">{name}</p>}
          </div>
        </t.In>
      )}
    </>
  );
};

export type KanbanCardsProps<T extends KanbanItemProps = KanbanItemProps> = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "id"
> & {
  children: (item: T) => ReactNode;
  id: string;
  empty?: ReactNode;
};

export const KanbanCards = <T extends KanbanItemProps = KanbanItemProps>({
  children,
  className,
  empty,
  ...props
}: KanbanCardsProps<T>) => {
  const { data } = useContext(KanbanContext) as KanbanContextProps<T>;
  const filteredData = data.filter((item) => item.column === props.id);
  const items = filteredData.map((item) => item.id);

  return (
    <div className="bevel-in relative m-[3px] mt-0 min-h-0 flex-1 overflow-y-auto bg-muted/40">
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div className={cn("flex min-h-full grow flex-col gap-1.5 p-1.5", className)} {...props}>
          {filteredData.map(children)}
          {filteredData.length === 0 && empty}
        </div>
      </SortableContext>
    </div>
  );
};

export type KanbanHeaderProps = HTMLAttributes<HTMLDivElement>;

export const KanbanHeader = ({ className, ...props }: KanbanHeaderProps) => (
  <div className={cn("m-0 px-2 py-1.5 text-[13px] font-bold", className)} {...props} />
);

export type KanbanMove<T> = { item: T; from: string; to: string };

export type KanbanProviderProps<
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
> = Omit<DndContextProps, "children" | "onDragEnd" | "onDragStart"> & {
  children: (column: C) => ReactNode;
  className?: string;
  columns: C[];
  data: T[];
  /** A card was dropped on another column. The caller decides whether it moves. */
  onMove?: (move: KanbanMove<T>) => void;
  onDragStart?: (event: DragStartEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  /** False leaves only the keyboard sensor: on a phone, dragging becomes a menu. */
  pointerDrag?: boolean;
  /** Rendered inside the drag context above the columns, for a lane that takes drops too. */
  lane?: ReactNode;
};

/* Space picks up and drops, as in dnd-kit's own examples; Enter opens the card. */
const KEYS = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space],
};

/* Pointer first so a drop on an empty column lands there, then the nearest corner. */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : closestCorners(args);
};

export const KanbanProvider = <
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
>({
  children,
  onDragStart,
  onDragEnd,
  onMove,
  className,
  columns,
  data,
  pointerDrag = true,
  lane,
  ...props
}: KanbanProviderProps<T, C>) => {
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const droppedAt = useRef(0);
  const [overColumn, setOverColumn] = useState<string | null>(null);

  const mouse = useSensor(MouseSensor, { activationConstraint: { distance: 5 } });
  const touch = useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } });
  const keyboard = useSensor(KeyboardSensor, {
    keyboardCodes: KEYS,
    coordinateGetter: sortableKeyboardCoordinates as KeyboardCoordinateGetter,
  });
  // dnd-kit wants a fixed sensor list, so the context remounts when this changes (key below).
  const sensors = useSensors(pointerDrag ? mouse : null, pointerDrag ? touch : null, keyboard);

  const columnOf = (id: string | number | undefined | null): string | null => {
    if (id === undefined || id === null) return null;
    const item = data.find((i) => i.id === id);
    if (item) return item.column;
    return columns.find((c) => c.id === id)?.id ?? null;
  };

  const handleDragStart = (event: DragStartEvent) => {
    const card = data.find((item) => item.id === event.active.id);
    if (card) {
      setActiveCardId(event.active.id as string);
      setOverColumn(card.column);
    }
    onDragStart?.(event);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    droppedAt.current = Date.now();
    setActiveCardId(null);
    setOverColumn(null);
    onDragEnd?.(event);

    const { active, over } = event;
    const item = data.find((i) => i.id === active.id);
    const to = columnOf(over?.id);
    if (!item || !to || to === item.column) return;
    onMove?.({ item, from: item.column, to });
  };

  const name = (id: string | null) => columns.find((c) => c.id === id)?.name ?? "no column";

  const announcements: Announcements = useMemo(
    () => ({
      onDragStart({ active }) {
        const { name: card, column } = data.find((item) => item.id === active.id) ?? {};
        return `Picked up ${card} from ${name(column ?? null)}. Arrow keys move it, Space drops it, Escape cancels.`;
      },
      onDragOver({ active, over }) {
        const { name: card } = data.find((item) => item.id === active.id) ?? {};
        return `${card} is over ${name(columnOf(over?.id))}.`;
      },
      onDragEnd({ active, over }) {
        const { name: card } = data.find((item) => item.id === active.id) ?? {};
        return `Dropped ${card} on ${name(columnOf(over?.id))}.`;
      },
      onDragCancel({ active }) {
        const { name: card } = data.find((item) => item.id === active.id) ?? {};
        return `Put ${card} back.`;
      },
    }),
    [data, columns],
  );

  return (
    <KanbanContext.Provider value={{ columns, data, activeCardId, overColumn, droppedAt }}>
      <DndContext
        key={pointerDrag ? "pointer" : "keyboard"}
        accessibility={{ announcements }}
        collisionDetection={collision}
        onDragEnd={handleDragEnd}
        onDragOver={(e) => setOverColumn(columnOf(e.over?.id))}
        onDragCancel={() => {
          droppedAt.current = Date.now();
          setActiveCardId(null);
          setOverColumn(null);
        }}
        onDragStart={handleDragStart}
        sensors={sensors}
        {...props}
      >
        {lane}
        <div className={cn("relative grid size-full auto-cols-fr grid-flow-col gap-2", className)}>
          {columns.map((column) => children(column))}
        </div>
        {typeof window !== "undefined" &&
          createPortal(
            <DragOverlay dropAnimation={null}>
              <t.Out />
            </DragOverlay>,
            document.body,
          )}
      </DndContext>
    </KanbanContext.Provider>
  );
};
