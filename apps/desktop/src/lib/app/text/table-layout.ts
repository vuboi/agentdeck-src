/**
 * Column widths for a table in an answer (.md-table), worked out from its text, plus drag-to-resize on the header edge.
 *
 * Each column has a minimum (its header, and its longest word up to a cap) and an ideal (its longest cell up to a cap).
 * The card's width is shared by how far each column's ideal is above its minimum: a short column ("Severity") keeps its
 * own width, a text column takes the rest. A table whose minimums do not fit scrolls sideways instead of overlapping.
 */

const CELL_PAD = 26; // 0.8rem each side, as in app.css
const HEAD_PAD = CELL_PAD + 2;
const WORD_CAP = 140;
const IDEAL_CAP = 420;
const MIN_COL = 56;
export const GRIP = 6;

let canvas: CanvasRenderingContext2D | null | undefined;

function width(text: string, font: string): number {
    if (canvas === undefined)
        canvas = document.createElement('canvas').getContext('2d');
    if (!canvas) return text.length * 7.5;
    canvas.font = font;
    return canvas.measureText(text).width;
}

const fontOf = (el: Element) => {
    const s = getComputedStyle(el);
    return `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
};

function setWidths(table: HTMLTableElement, widths: number[]) {
    table.querySelector('colgroup')?.remove();
    const group = document.createElement('colgroup');
    for (const w of widths) {
        const col = document.createElement('col');
        col.style.width = `${Math.round(w)}px`;
        group.append(col);
    }
    table.prepend(group);
    table.style.width = `${Math.round(widths.reduce((a, b) => a + b, 0))}px`;
    table.dataset.fixed = '';
}

/** A table the reader resized by hand keeps its widths; the last column takes any room the card has left. */
function fitManual(card: HTMLElement, table: HTMLTableElement): void {
    const avail = card.clientWidth - 2;
    const cols = [...table.querySelectorAll('col')];
    if (avail <= 0 || cols.length === 0) return;
    const widths = cols.map((c) => parseFloat(c.style.width) || 0);
    const sum = widths.reduce((a, b) => a + b, 0);
    if (sum < avail) {
        const last = cols.length - 1;
        cols[last].style.width = `${Math.round(widths[last] + avail - sum)}px`;
    }
    table.style.width = `${Math.round(Math.max(avail, sum))}px`;
}

/** Lay out one table card by the formula above. A table the reader has resized by hand is kept as they set it, filling the card. */
export function layoutTable(card: HTMLElement): void {
    const table = card.querySelector('table');
    if (!table) return;
    if (table.dataset.manual !== undefined) return fitManual(card, table);
    const avail = card.clientWidth - 2;
    const head = table.rows[0];
    if (avail <= 0 || !head) return;
    const cols = head.cells.length;
    const headFont = fontOf(head.cells[0]);
    const bodyCell = table.querySelector('td');
    const bodyFont = bodyCell ? fontOf(bodyCell) : headFont;

    const min: number[] = [];
    const ideal: number[] = [];
    for (let i = 0; i < cols; i++) {
        const headW = width(head.cells[i].textContent?.trim() ?? '', headFont);
        let longest = 0;
        let whole = 0;
        for (const row of table.tBodies[0]?.rows ?? []) {
            const text = row.cells[i]?.textContent?.trim() ?? '';
            whole = Math.max(whole, width(text, bodyFont));
            for (const word of text.split(/\s+/))
                longest = Math.max(longest, width(word, bodyFont));
        }
        min.push(
            Math.max(
                MIN_COL,
                headW + HEAD_PAD,
                Math.min(longest, WORD_CAP) + CELL_PAD,
            ),
        );
        ideal.push(
            Math.max(
                min[i],
                Math.min(Math.max(whole, headW), IDEAL_CAP) + CELL_PAD,
            ),
        );
    }

    const sumMin = min.reduce((a, b) => a + b, 0);
    const sumIdeal = ideal.reduce((a, b) => a + b, 0);
    const excess = ideal.map((w, i) => w - min[i]);
    const sumExcess = excess.reduce((a, b) => a + b, 0);
    let widths: number[];
    if (sumMin >= avail) widths = min;
    else if (sumExcess <= 0) widths = ideal.map((w) => (w * avail) / sumIdeal);
    else {
        // Up to its ideal a column grows by its share of the room; past it (the card is wider than every cell) the rest is
        // shared the same way, so the table still fills the card.
        const room = avail - sumMin;
        widths = min.map((w, i) => w + (room * excess[i]) / sumExcess);
    }
    setWidths(table, widths);
}

/** The header cell edge under the pointer, or null: the grip a drag starts from. */
export function gripAt(
    event: PointerEvent | MouseEvent,
): HTMLTableCellElement | null {
    const th = (
        event.target as HTMLElement | null
    )?.closest<HTMLTableCellElement>('.md-table th');
    if (!th) return null;
    return th.getBoundingClientRect().right - event.clientX <= GRIP ? th : null;
}

/** Drag the right edge of a header cell: its column follows the pointer, the table grows or shrinks with it. */
export function startResize(
    th: HTMLTableCellElement,
    event: PointerEvent,
): void {
    const table = th.closest('table');
    if (!table) return;
    if (!table.querySelector('col'))
        layoutTable(th.closest('.md-table') as HTMLElement);
    const cols = [...table.querySelectorAll('col')];
    const idx = th.cellIndex;
    if (!cols[idx]) return;
    event.preventDefault();
    table.dataset.manual = '';
    const card = th.closest<HTMLElement>('.md-table');
    // A narrower column hands its room to the next one (the previous one for the last column), so the table stays full width.
    const giver = idx + 1 < cols.length ? idx + 1 : idx - 1;
    const widths = cols.map((c) => parseFloat(c.style.width) || 0);
    const start = event.clientX;
    const base = widths[idx];
    th.dataset.dragging = '';
    const move = (e: PointerEvent) => {
        const avail = (card?.clientWidth ?? 0) - 2;
        const sized = widths.map((w, i) =>
            i === idx ? Math.max(MIN_COL, base + e.clientX - start) : w,
        );
        const total = sized.reduce((a, b) => a + b, 0);
        if (giver >= 0 && total < avail) sized[giver] += avail - total;
        cols.forEach((c, i) => (c.style.width = `${Math.round(sized[i])}px`));
        const width = Math.max(avail, total);
        table.style.width = `${Math.round(width)}px`;
    };
    const stop = () => {
        delete th.dataset.dragging;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
}
