"use client";

const WINDOW = 5;

/** The page numbers shown: up to 5, the current one in the middle where it can be. */
export function pageWindow(page: number, pages: number): number[] {
    const size = Math.min(WINDOW, pages);
    const start = Math.max(1, Math.min(page - Math.floor(size / 2), pages - size + 1));
    return Array.from({ length: size }, (_, i) => start + i);
}

const pill =
    "grid h-10 min-w-10 cursor-pointer place-items-center rounded-full px-3 text-[15px] font-medium tabular-nums outline-2 outline-offset-2 outline-transparent transition-colors duration-150 focus-visible:outline-solid disabled:cursor-default disabled:opacity-40";

/** Previous, the pages around this one, and next; nothing at all when there is a single page. */
export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
    if (pages <= 1) return null;
    return (
        <nav aria-label="Pages" className="mt-1 mb-2 flex flex-wrap items-center justify-center gap-1">
            <button
                type="button"
                aria-label="Previous"
                className={`${pill} text-muted hover:text-foreground disabled:hover:text-muted`}
                disabled={page <= 1}
                onClick={() => onPage(page - 1)}
            >
                <span aria-hidden="true">‹</span>
            </button>
            {pageWindow(page, pages).map((n) => (
                <button
                    key={n}
                    type="button"
                    aria-current={n === page ? "page" : undefined}
                    className={`${pill} ${n === page ? "bg-pill text-foreground" : "text-muted hover:text-foreground"}`}
                    onClick={() => onPage(n)}
                >
                    {n}
                </button>
            ))}
            <button
                type="button"
                aria-label="Next"
                className={`${pill} text-muted hover:text-foreground disabled:hover:text-muted`}
                disabled={page >= pages}
                onClick={() => onPage(page + 1)}
            >
                <span aria-hidden="true">›</span>
            </button>
        </nav>
    );
}
